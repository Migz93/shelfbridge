# Future Work

This file captures planned work that is intentionally not implemented yet.
Completed architecture notes and operational details belong in the topic docs
under `docs/`, not here.

---

## Hardcover Edition Suggestion for ABS Mismatches

### Background

When Audiobookshelf reports that an audiobook's duration (`audiobookshelf_duration`
in `book_sources`) differs from the duration stored on the user's current Hardcover
edition (`hardcover_audio_seconds`), ShelfBridge flags the book in the
**ABS Runtime Mismatch** filter on the Audiobooks page. The flag tells the user
something is wrong, but it does not tell them what to switch to.

The goal of this feature is: when a mismatch is detected, automatically find the
correct Hardcover edition (using the ABS item's ASIN and duration), and surface a
one-click "Switch edition" action on the book detail page.

### Reference implementation

The other ShelfBridge project (unrelated, same name) at
**https://github.com/rohit-purandare/ShelfBridge** has a fully working edition
scorer and selector for exactly this use case. The relevant files are:

- `src/matching/edition-selector.js` — scoring engine (start here)
- `src/matching/strategies/asin-matcher.js` — ASIN-first lookup strategy
- `src/matching/utils/text-matching.js` — `calculateDurationSimilarity()` and
  narrator string normalisation
- `src/hardcover-client.js` — `searchBooksByAsin(asin)` GraphQL query (line ~926)

### What the scoring system does

Given an ABS audiobook item and a set of candidate Hardcover editions, it scores
each edition on five factors:

| Factor | Weight | How it works |
|---|---|---|
| **Format match** | 40% | Does `reading_format.format` contain "audiobook"? Perfect = 100, ebook fallback = 62, physical = 37 |
| **Popularity** | 23% | `users_count` on the edition — log₁₀ scale, 20–100. More users = more likely canonical |
| **Duration match** | 19% | `audio_seconds` vs ABS duration. ≤3% diff = 100, ≤5% = 95, ≤10% = 85, ≤20% = 70, ≤30% = 50, >30% = 20 |
| **Completeness** | 15% | Edition has ASIN (+20), ISBN (+20), pages (+15), audio_seconds (+15), format (+15), users_count (+15) |
| **Narrator match** | 3% | Jaro-Winkler string similarity between ABS `narrator` and HC edition narrator |

Total score is capped 0–100. Bonuses: +3 for perfect format match, up to +2 for
>1000 users (log scale).

### How to find candidate editions

The reference app uses this HC GraphQL query (already usable with our
`hardcoverQuery` helper in `src/server/sync/hardcover.ts`):

```graphql
query searchBooksByAsin($asin: String!) {
  editions(where: { asin: { _eq: $asin } }) {
    id
    isbn_10
    isbn_13
    asin
    pages
    audio_seconds
    physical_format
    reading_format { format }
    score
    contributions {
      author { id name }
      contribution
    }
    book {
      id
      title
      contributions(where: { contributable_type: { _eq: "Book" } }) {
        author { id name }
      }
    }
  }
}
```

If the ABS item has no ASIN, fall back to searching by HC book ID to get all
editions for that book, then score them:

```graphql
query GetAllEditions($bookId: Int!) {
  editions(where: { book_id: { _eq: $bookId }, audio_seconds: { _gt: 0 } }) {
    id
    asin
    audio_seconds
    pages
    reading_format { format }
    users_count
    # ... same fields as above
  }
}
```

### Data already in place

All the raw data needed is already collected and stored:

| What | Where |
|---|---|
| ABS item ASIN | `book_sources.audiobookshelf_asin` (source_type='audiobookshelf') |
| ABS duration | `book_sources.audiobookshelf_duration` |
| Current HC edition id | `user_book_states.hardcover_edition_id` (source_type='hardcover') ... or look up via `book_sources.source_edition_id` |
| HC edition audio_seconds | `book_sources.hardcover_audio_seconds` |
| HC user_book_id | `user_book_states.hardcover_user_book_id` |
| Mismatch flag already computed | `books.ts` route, `absRuntimeMismatchBookIds` set |

### Implementation plan

1. **New API endpoint**: `POST /api/books/:bookId/relationships/:profileId/suggest-hc-edition`
   - Looks up `audiobookshelf_asin` and `audiobookshelf_duration` for this book
   - Calls `searchBooksByAsin(asin)` on HC (or fetches all audiobook editions for
     the book's HC `book_id` when ASIN is absent)
   - Scores all returned editions using the scoring weights above
   - Returns ranked list: `[{ editionId, asin, audio_seconds, format, usersCount, score, narratorName, durationDeltaPct }]`

2. **New API endpoint**: `PATCH /api/books/:bookId/relationships/:profileId/hc-edition`
   - Accepts `{ editionId: number }`
   - Calls `update_user_book(id: userBookId, object: { edition_id: editionId })` on HC
   - Updates `book_sources.hardcover_audio_seconds` and `user_book_states.hardcover_edition_id` locally
   - Triggers a re-check of the mismatch flag (will clear when durations align)

3. **UI on the book detail page** (`src/client/pages/Books.tsx`)
   - In the ABS tab panel of `UserBookRelationshipCard`, when `audiobookshelfRuntimeValidated`
     is true but `abs-runtime-mismatch` is flagged:
     - Show a warning: "HC edition duration differs by X% from this file"
     - "Find correct edition" button → calls suggest endpoint → renders a list of
       scored alternatives with duration, format, users count, score, narrator
     - "Switch to this edition" → calls PATCH endpoint → clears the mismatch flag

### Notes / gotchas

- The `update_user_book` mutation already exists in `hardcover.ts` as
  `updateHardcoverUserBook` — just pass `{ edition_id: editionId }` in the `fields`
  object; it uses `UserBookUpdateInput` which accepts `edition_id`
- After switching editions, re-run Phase C logic locally (or just wait for next sync)
  to refresh `hardcover_audio_seconds` from the new edition's `audio_seconds`
- The narrator field on ABS items is in `media.metadata.narratorName`; it is already
  stored in `book_sources.source_narrator` on the ABS source row if we add it to
  Phase M — currently only stored for Grimmory source rows
- Duration similarity threshold of 3% covers the same recording by different
  distributors; 5% starts to catch abridged vs unabridged; anything >20% is almost
  certainly the wrong book or a drastically different version
