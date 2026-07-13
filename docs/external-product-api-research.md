# External Product API Research

This file captures API details for the external products ShelfBridge talks to:
Grimmory, Hardcover, and Goodreads. It is reference material for integrations,
not a ShelfBridge product API spec. For ShelfBridge's own REST API, see
[`api.md`](api.md).

## 1. Grimmory API

Base shape:

- REST API
- local OpenAPI available at `/api/openapi.json`
- auth is JWT bearer auth

### 1.1 Grimmory auth flow

Confirmed behavior from the live instance and from the Grimmory source:

1. `POST /api/v1/auth/login`
2. response returns:
   - `accessToken`
   - `refreshToken`
   - `isDefaultPassword`
3. authenticated requests send:
   - `Authorization: Bearer <accessToken>`

This was validated against the live Grimmory instance and also matches the upstream source code.

Live login response shape:

```json
{
  "refreshToken": "...",
  "accessToken": "...",
  "isDefaultPassword": "false"
}
```

Upstream source behavior:

- backend JWT filter only reads `Authorization: Bearer ...`
- frontend stores:
  - `accessToken_Internal`
  - `refreshToken_Internal`
- frontend adds the bearer token to API calls automatically

Practical implication:

- the bridge app can act as a specific Grimmory user by logging in as that user
- this is a per-user auth model, not an admin API key model

### 1.2 Grimmory endpoints most relevant to this app

#### Connection and identity

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `GET /api/v1/users/me`
- `GET /api/v1/app/users/me`

#### Books and user-facing inventory

- `GET /api/v1/app/books`
  - paginated app-facing list of books
  - uses `BookListRequest` style filters
- `GET /api/v1/app/books/{bookId}`
  - app-facing detail view for a single book
- `GET /api/v1/app/books/search?q=...`
  - free-text search
- `GET /api/v1/app/books/ids`
  - IDs matching filters without pagination

#### Read state and progress

- `PUT /api/v1/app/books/{bookId}/status`
  - body:

```json
{ "status": "READ" }
```

- `GET /api/v1/app/books/{bookId}/progress`
- `PUT /api/v1/app/books/{bookId}/progress`

Also available in bulk-style endpoints:

- `POST /api/v1/books/status`
- `POST /api/v1/books/progress`

For v1, the app-facing endpoints are likely simpler and safer.

#### Shelves

- `GET /api/v1/app/shelves`
- `GET /api/v1/shelves`
- `POST /api/v1/shelves`
- `GET /api/v1/shelves/{shelfId}/books`
- `POST /api/v1/books/shelves`

Shelf assignment body:

```json
{
  "bookIds": [123],
  "shelvesToAssign": [45],
  "shelvesToUnassign": []
}
```

### 1.3 Grimmory status model

From the OpenAPI schema:

- `UNREAD`
- `READING`
- `RE_READING`
- `READ`
- `PARTIALLY_READ`
- `PAUSED`
- `WONT_READ`
- `ABANDONED`
- `UNSET`

Useful sync subset for this project:

- `READING`
- `RE_READING`
- `READ`
- `PARTIALLY_READ`
- `PAUSED`
- `ABANDONED`
- `WONT_READ`

Observed against live Grimmory on book 28:

- current read state is stored as top-level `readStatus`
- `UNSET`, `UNREAD`, `READING`, `RE_READING`, and `PARTIALLY_READ` only changed
  `readStatus`
- `READ` adds top-level `dateFinished`
- changing away from `READ` clears `dateFinished`
- these UI status changes did not update `lastReadTime` or `readProgress`

### 1.4 Grimmory book data useful for matching

Useful fields available in app book responses:

- `id`
- `title`
- `authors`
- `isbn13`
- `isbn10`
- `seriesName`
- `seriesNumber`
- `publishedDate`
- `readStatus`
- `readProgress`
- `lastReadTime`
- `shelves`

Useful fields in progress payloads:

- `readProgress`
- `lastReadTime`
- file-specific progress data

### 1.5 Grimmory shelf notes

The `Shelf` schema includes:

- `id`
- `name`
- `userId`
- `publicShelf`

Implication:

- shelves are tied to users
- shelf mirroring can stay safely per person

### 1.6 Grimmory source references

Local cloned source used for verification:

- `grimmory-upstream/backend/src/main/java/org/booklore/config/security/filter/JwtAuthenticationFilter.java`
- `grimmory-upstream/backend/src/main/java/org/booklore/config/security/SecurityConfig.java`
- `grimmory-upstream/backend/src/main/java/org/booklore/config/security/service/AuthenticationService.java`
- `grimmory-upstream/frontend/src/app/shared/service/auth.service.ts`
- `grimmory-upstream/frontend/src/app/core/security/auth-interceptor.service.ts`

## 2. Hardcover API

Base shape:

- GraphQL API
- authenticated per user via API token
- official docs say this is the same API used by the website and mobile apps

Official docs:

- Getting started: [https://docs.hardcover.app/api/getting-started/](https://docs.hardcover.app/api/getting-started/)
- Books schema: [https://docs.hardcover.app/api/graphql/schemas/books/](https://docs.hardcover.app/api/graphql/schemas/books/)
- Users schema: [https://docs.hardcover.app/api/graphql/schemas/users/](https://docs.hardcover.app/api/graphql/schemas/users/)
- Search guide: [https://docs.hardcover.app/api/guides/searching/](https://docs.hardcover.app/api/guides/searching/)
- Getting books in library: [https://docs.hardcover.app/api/guides/gettingallbooksinlibrary/](https://docs.hardcover.app/api/guides/gettingallbooksinlibrary/)

### 2.1 Hardcover auth flow

Per official docs:

- the user gets an API token from Hardcover account settings
- requests send a header named `authorization`
- the token value is used directly

Example query from the docs:

```graphql
query {
  me {
    id
    username
  }
}
```

Important note from the docs:

- actions happen under that exact Hardcover user

That fits your requirement perfectly.

### 2.2 Hardcover user library statuses

Official status mapping from the Books docs:

- `1` = Want to Read
- `2` = Currently Reading
- `3` = Read
- `4` = Paused
- `5` = Did Not Finished
- `6` = Ignored

The user-facing buckets you care about are:

- Want to Read
- Currently Reading
- Read
- Did Not Finish

### 2.3 Hardcover queries relevant to this app

#### Identify the current Hardcover user

```graphql
query {
  me {
    id
    username
  }
}
```

#### Fetch the user's selected edition metadata

ShelfBridge now relies on `user_books.edition_id` plus an edition lookup to
distinguish print/ebook variants from audiobooks and to fetch edition-specific
cover art.

Confirmed live against Hardcover on May 14, 2026:

- `editions(where: { id: { _eq: 31501578 } })` returns:
  - `edition_format`
  - `isbn_13`
  - `isbn_10`
  - `asin`
  - `pages`
  - `image { url }`

That `image.url` is important because audiobook editions can have different,
often square, artwork from the parent book's default cover image. ShelfBridge
now prefers the selected edition image when caching Hardcover covers.

#### Get a user’s library books

The docs explicitly show querying `user_books` by `user_id`.

Example shape:

```graphql
query GetUserBooks($userId: Int!) {
  user_books(
    where: { user_id: { _eq: $userId } }
    distinct_on: book_id
    order_by: [{ updated_at: desc }]
  ) {
      id
      edition_id
      status_id
      updated_at
    first_started_reading_date
    last_read_date
    rating
    book {
      id
      title
      slug
      isbns
      release_date
      contributions {
        author {
          name
        }
      }
    }
    user_book_reads(order_by: [{ id: desc }], limit: 1) {
      id
      progress
      progress_pages
      progress_seconds
      started_at
      finished_at
    }
  }
}
```

#### Search Hardcover books

Official search guide says the search API takes:

- `query`
- `query_type`
- `page`
- `per_page`
- optional sort and fields tuning

Likely useful query:

```graphql
query SearchBooks($query: String!) {
  search(query: $query, query_type: "book", per_page: 10, page: 1) {
    ids
    results
  }
}
```

### 2.4 Hardcover mutations relevant to this app

These were found in the official public GraphQL schema in the Hardcover docs repo.

#### Create a user-book library entry

```graphql
mutation InsertUserBook($object: UserBookCreateInput!) {
  insert_user_book(object: $object) {
    id
    error
  }
}
```

#### Update a user-book library entry

```graphql
mutation UpdateUserBook($id: Int!, $object: UserBookUpdateInput!) {
  update_user_book(id: $id, object: $object) {
    id
    error
  }
}
```

#### Delete a user-book entry

```graphql
mutation DeleteUserBook($id: Int!) {
  delete_user_book(id: $id) {
    id
  }
}
```

#### Insert a read/progress record

```graphql
mutation InsertUserBookRead($userBookId: Int!, $read: DatesReadInput!) {
  insert_user_book_read(user_book_id: $userBookId, user_book_read: $read) {
    id
    error
  }
}
```

#### Update a read/progress record

```graphql
mutation UpdateUserBookRead($id: Int!, $object: DatesReadInput!) {
  update_user_book_read(id: $id, object: $object) {
    id
    error
  }
}
```

### 2.5 Hardcover input types relevant to this app

Useful fields from `UserBookCreateInput` and `UserBookUpdateInput`:

- `book_id`
- `edition_id`
- `status_id`
- `rating`
- `first_started_reading_date`
- `last_read_date`
- `read_count`
- `private_notes`

Useful fields from `DatesReadInput`:

- `id`
- `edition_id`
- `started_at`
- `finished_at`
- `progress_pages`
- `progress_seconds`
- `action`

Useful fields from `user_books`:

- `id`
- `book_id`
- `edition_id`
- `status_id`
- `created_at`
- `updated_at`
- `date_added`
- `first_started_reading_date`
- `last_read_date`
- `edition_id`
- `read_count`
- `rating`

Important implication for ShelfBridge:

- `user_books.edition_id` is required if we want to distinguish a user's
  audiobook edition from Hardcover's default physical/ebook/audio editions
- relying only on `default_physical_edition`, `default_ebook_edition`, and
  `default_audio_edition` is good enough for book-level matching, but it is not
  reliable for identifying which specific edition the user actually saved

Useful fields from `user_book_reads`:

- `id`
- `user_book_id`
- `progress`
- `progress_pages`
- `progress_seconds`
- `started_at`
- `finished_at`
- `edition_id`

### 2.6 Hardcover constraints and implications

#### What looks solid

- per-user auth
- read access to user library
- mutation support for user library entries
- mutation support for progress/read records

#### What needs proof-of-concept during build

- exact mutation behavior for changing status without side effects
- whether `user_book_reads` or `user_books.updated_at` is the better conflict timestamp
- whether adding a status entry creates duplicates unless you use existing `user_book.id`
- how best to represent “mark unread” when removing or downgrading a book

### 2.7 Matching implications

Hardcover search is text-oriented.

That means the sync app should prefer:

- ISBN matching first
- then title plus author
- only then free-text search

For missing-book workflows, the app should:

- show the Hardcover book
- show likely Grimmory candidates from Grimmory search
- let the user confirm a match
- avoid automatic low-confidence linking

## 3. Goodreads read-only source

### 3.1 PirateReads approach

I inspected the public PirateReads repository:

- repo: [https://github.com/mariannefeng/piratereads](https://github.com/mariannefeng/piratereads)

Important finding:

- PirateReads is not using a hidden private Goodreads API
- it fetches Goodreads public shelf RSS feeds
- it converts the RSS XML into JSON

The core request pattern in PirateReads is:

```text
https://www.goodreads.com/review/list_rss/{user_id}?shelf={shelf}&per_page={perPage}&page={page}
```

Supported shelf names in PirateReads:

- `to-read`
- `currently-reading`
- `read`
- `did-not-finish`

PirateReads then exposes simplified endpoints like:

- `/{user_id}/want-to-read`
- `/{user_id}/currently-reading`
- `/{user_id}/read`
- `/{user_id}/dnf`

PirateReads returns a simplified JSON shape focused on:

- book title
- author name
- cover image URLs
- Goodreads book link
- average rating
- user rating on `read`
- user review text on `read` and `did-not-finish`
- review publish date

### 3.2 `goodreads-bookshelf-api` approach

I also inspected:

- repo: [https://github.com/tnmyk/goodreads-bookshelf-api](https://github.com/tnmyk/goodreads-bookshelf-api)

This one is also RSS-based.

It fetches:

```text
https://www.goodreads.com/review/list_rss/{username-or-profile-slug}?shelf={shelf}
```

Important comparison:

- it is not a different Goodreads backend
- it is the same Goodreads RSS source family
- the difference is in parsing and output shape, not the underlying access method

It parses the RSS `content` block into richer structured fields like:

- `author`
- `name`
- `averageRating`
- `bookPublished`
- `rating`
- `readAt`
- `dateAdded`
- `shelves`
- `review`
- `imageLink`
- `bookLink`
- plus raw RSS metadata like `guid`, `pubDate`, and `isoDate`

It also accepts a Goodreads profile slug style value such as:

- `50993735-emma-watson`

where PirateReads is designed around the numeric Goodreads user ID.

### 3.3 Comparison: PirateReads vs `goodreads-bookshelf-api`

Same underlying source:

- both use Goodreads public shelf RSS

Main differences:

- PirateReads is a hosted API wrapper plus a small backend service
- `goodreads-bookshelf-api` is a reusable Node library
- PirateReads uses numeric Goodreads user IDs
- `goodreads-bookshelf-api` uses the Goodreads profile slug or username-style path segment
- PirateReads returns a simpler response
- `goodreads-bookshelf-api` returns richer parsed shelf metadata

Which looks better for matching:

- `goodreads-bookshelf-api` likely gives more useful fields for pairing against Hardcover
- especially `dateAdded`, `readAt`, `shelves`, `bookPublished`, raw RSS timestamps, and the Goodreads `bookLink`

What PirateReads still offers:

- a very straightforward JSON API shape
- support for `did-not-finish`
- easy self-host reference implementation

### 3.4 Recommendation for your app

Do not depend on PirateReads as a production dependency if you can avoid it.

Better options:

1. build your own Goodreads provider module around Goodreads RSS
2. borrow parsing ideas from both PirateReads and `goodreads-bookshelf-api`
3. optionally keep one provider as a fallback mode during development

Why:

- your app stays self-contained
- you are not depending on a third-party rate limit or uptime
- the logic is simple enough to replicate
- you can expose a normalized internal Goodreads book model regardless of which parser wins

### 3.5 Goodreads data shape available from public shelves

Across both repos, the Goodreads RSS shelf data exposes at least:

- book title
- author name
- cover image URLs
- Goodreads book link
- average rating
- Goodreads review URL or GUID
- feed publish dates and ISO dates
- user rating on `read`
- user review text on `read` and `did-not-finish`
- review publish date
- date added
- read-at date
- shelf names
- likely user display name from the feed

This is enough for:

- read-only shelf import
- matching against existing ShelfBridge book links
- optional Goodreads status/rating enrichment into matched Grimmory books

This is not enough to assume full private Goodreads account parity.

### 3.6 Goodreads provider strategy recommendation

For the build phase, define two internal Goodreads provider modes:

1. `rss-simple`
   - numeric user ID oriented
   - PirateReads-style parsing
2. `rss-rich`
   - profile slug oriented
   - `goodreads-bookshelf-api` style parsing

Then normalize both into one internal model.

Recommended normalized Goodreads book shape:

- `goodreadsBookLink`
- `goodreadsReviewLink`
- `title`
- `author`
- `coverImage`
- `averageRating`
- `userRating`
- `reviewText`
- `reviewPublishedAt`
- `dateAdded`
- `readAt`
- `shelves`
- `sourceProfileIdentifier`
- `sourceProvider`

This gives you room to try both strategies and keep whichever yields better coverage and matching quality.

### 3.7 Goodreads constraints

- Goodreads is not offering an official modern public general-purpose API here
- public shelf RSS can change or break
- some Goodreads data may only be available for public profiles or public shelves
- rate limiting and scraping etiquette matter

### 3.8 Goodreads provider interface to model in your app

If you self-host the PirateReads-style logic, your internal Goodreads provider module should support:

- fetch `to-read`
- fetch `currently-reading`
- fetch `read`
- fetch `did-not-finish`
- pagination via `per_page` and `page`

### 3.9 Goodreads sync notes

Current ShelfBridge behavior:

- Goodreads remains read-only.
- Goodreads data enriches existing ShelfBridge book links.
- When enabled per profile, Goodreads shelf changes can write status to matched
  Grimmory books, and available Goodreads ratings can write rating values when
  Grimmory is not newer.
- Goodreads custom shelves can be mapped additively to Grimmory shelves.
- ShelfBridge does not write back to Goodreads.

## 4. Combined sync design implications

### 4.1 Per-person sync is the right model

Both Grimmory and Hardcover act as the authenticated user.

Goodreads is public-read-only and still naturally belongs to one linked person.

That means the bridge app should never treat syncing as a global admin operation. Every action should happen inside one linked profile at a time.

### 4.2 Best v1 write direction

Recommended:

- two-way status and progress sync between Grimmory and Hardcover
- additive bidirectional Hardcover list ↔ Grimmory shelf mirroring
- optional one-way Goodreads enrichment into matched Grimmory books
- read-only missing-book assistance

### 4.3 Recommended conflict timestamps

Use these as the first-pass conflict signals:

- Grimmory status:
  - `readStatusModifiedTime` where available
- Grimmory progress:
  - `lastReadTime`
- Hardcover status:
  - `user_books.updated_at`
- Hardcover progress:
  - latest `user_book_reads` record plus `user_books.updated_at`
- Goodreads:
  - weakest source, mostly shelf presence and review date, not high-confidence live progress

## 5. Required APIs by Sync Direction

This section is the practical checklist for implementation.

## 5.1 Update a book in Hardcover from Grimmory

Goal examples:

- reflect Grimmory read status in Hardcover
- copy personal rating into Hardcover
- copy finished or read date into Hardcover

### Data needed before writing

From Grimmory:

- `book.id`
- `title`
- `authors`
- `isbn13`
- `isbn10`
- `seriesName`
- `seriesNumber`
- `readStatus`
- `personalRating`
- `lastReadTime`
- `dateFinished`
- `readProgress`

From Hardcover:

- `me.id`
- matched `book.id`
- existing `user_books.id`
- current `status_id`
- current `rating`
- current `updated_at`
- latest `user_book_reads.id`

### Matching data needed

Grimmory is stronger than Goodreads for matching because it exposes:

- `isbn13`
- `isbn10`
- title
- authors
- series

This means Hardcover matching should prefer:

1. ISBN
2. title + author
3. title + author + series

### Likely Hardcover APIs required

- `me`
- `user_books(...)`
- `search(...)`
- `insert_user_book(...)`
- `update_user_book(...)`
- optionally `insert_user_book_read(...)`
- optionally `update_user_book_read(...)`

### What fields are likely written

From Grimmory to Hardcover, the most relevant fields are:

- `status_id`
- `rating`
- `last_read_date`
- possibly `first_started_reading_date`

If you map explicit read completion:

- Grimmory `READ` plus top-level `dateFinished` maps to Hardcover
  `status_id = 3` plus `last_read_date`

Current Grimmory -> Hardcover status actions:

| Grimmory ReadStatus | Hardcover action |
|---|---|
| `UNSET` | no write |
| `UNREAD` | no write |
| `READING` | `status_id = 2` |
| `RE_READING` | `status_id = 2` |
| `PARTIALLY_READ` | `status_id = 2` |
| `READ` | `status_id = 3`, plus `last_read_date` from `dateFinished` when present |
| `PAUSED` | `status_id = 4` |
| `ABANDONED` | `status_id = 5` |
| `WONT_READ` | `status_id = 6` |

If you ever sync partial progress:

- use `user_book_reads.progress`
- but only after a separate proof-of-concept confirms the semantics are safe

## 5.2 Update a book in Grimmory from Hardcover

Goal examples:

- match a Hardcover library book to a Grimmory book
- mirror reading status into Grimmory
- mirror rating into Grimmory if supported
- mirror shelf membership into Grimmory

### Data needed before writing

From Hardcover:

- `user_books.id`
- `book.id`
- `book.title`
- `book.isbns`
- `book.contributions.author.name`
- `status_id`
- `rating`
- `updated_at`
- `first_started_reading_date`
- `last_read_date`
- latest `user_book_reads.progress`
- latest `user_book_reads.started_at`
- latest `user_book_reads.finished_at`

From Grimmory:

- matched `AppBookSummary.id`
- current `readStatus`
- current `personalRating`
- current `lastReadTime`
- current shelves
- per-user available shelves

### Matching data needed

To match Hardcover against Grimmory, ShelfBridge likely needs:

- Hardcover ISBNs
- Grimmory `isbn13` and `isbn10`
- title
- author
- optionally series

### Likely Grimmory APIs required

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `GET /api/v1/users/me`
- `GET /api/v1/app/books`
- `GET /api/v1/app/books/search`
- `GET /api/v1/app/books/{bookId}`
- `GET /api/v1/app/shelves`
- `PUT /api/v1/app/books/{bookId}/status`
- `PUT /api/v1/app/books/{bookId}/progress`
- `PUT /api/v1/app/books/{bookId}/rating`
- `POST /api/v1/books/shelves`
- `POST /api/v1/shelves`

### What fields are likely written

From Hardcover to Grimmory, the most relevant writes are:

- read status
- personal rating
- optional progress
- shelf membership

### Status mapping likely used

- Hardcover `Want to Read` -> Grimmory `UNREAD` plus optional shelf
- Hardcover `Currently Reading` -> Grimmory `READING`
- Hardcover `Read` -> Grimmory `READ`
- Hardcover `Did Not Finish` -> Grimmory `ABANDONED`

### Rating notes

Grimmory exposes:

- `PUT /api/v1/app/books/{bookId}/rating`

with:

- `rating` on Grimmory's current 5-point personal rating write scale

ShelfBridge still treats Grimmory read values above 5 as legacy/imported
10-point ratings and halves them before writing to Hardcover.

## 5.3 Update a book in Grimmory from Goodreads

Current strategy:

- Goodreads is read-only.
- ShelfBridge matches Goodreads RSS entries to existing `book_sources` rows.
- When profile toggles allow it, ShelfBridge writes mapped Goodreads shelf status
  and eligible Goodreads user ratings to matched Grimmory books.
- Goodreads custom shelves can be mapped to Grimmory shelves additively.

Relevant Grimmory APIs:

- `PUT /api/v1/app/books/{bookId}/status`
- `PUT /api/v1/app/books/{bookId}/rating`
- `POST /api/v1/books/shelves`
- `POST /api/v1/shelves`

## 5.4 API Set Used By ShelfBridge

### Grimmory APIs

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `GET /api/v1/books/page`
- `GET /api/v1/app/books/{bookId}`
- `GET /api/v1/app/shelves`
- `GET /api/v1/app/books/{bookId}/progress`
- `PUT /api/v1/app/books/{bookId}/status`
- `PUT /api/v1/app/books/{bookId}/progress`
- `PUT /api/v1/app/books/{bookId}/rating`
- `PUT /api/v1/books/{bookId}/metadata`
- `GET /api/v1/media/book/{bookId}/cover`
- `POST /api/v1/books/shelves`
- `POST /api/v1/shelves`

### Hardcover APIs

- `me`
- `user_books(...)`
- `insert_user_book(...)`
- `update_user_book(...)`
- `insert_user_book_read(...)`
- `update_user_book_read(...)`
- `lists(...)`
- `insert_list_book(...)`

### Goodreads provider capabilities

- fetch `to-read`
- fetch `currently-reading`
- fetch `read`
- fetch `did-not-finish`
- expose normalized fields for matching:
  - title
  - author
  - shelf
  - rating
  - read-at date
  - date-added
  - Goodreads book link
