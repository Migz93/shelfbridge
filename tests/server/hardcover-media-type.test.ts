import assert from "node:assert/strict";
import test from "node:test";
import { inferHardcoverMediaType } from "../../src/server/sync/sync-utils.js";
import type { HardcoverEdition, HardcoverUserBook } from "../../src/server/sync/hardcover.js";

function userBook(overrides: Partial<HardcoverUserBook> = {}): HardcoverUserBook {
  return {
    id: 1,
    edition_id: 100,
    status_id: 1,
    rating: null,
    updated_at: null,
    first_started_reading_date: null,
    last_read_date: null,
    book: {
      id: 1,
      title: "Book",
      slug: null,
      default_physical_edition_id: null,
      default_ebook_edition_id: null,
      default_audio_edition_id: null,
      image: null,
      contributions: null,
      default_physical_edition: null,
      default_ebook_edition: null,
      default_audio_edition: null,
      book_series: null
    },
    user_book_reads: null,
    ...overrides
  };
}

function edition(overrides: Partial<HardcoverEdition> = {}): HardcoverEdition {
  return {
    id: 100,
    edition_format: null,
    reading_format_id: null,
    isbn_13: null,
    isbn_10: null,
    asin: null,
    pages: null,
    audio_seconds: null,
    image: null,
    ...overrides
  };
}

test("inferHardcoverMediaType resolves via reading_format_id, ignoring a blank/uninformative edition_format", () => {
  // Mirrors the real "No Exit" case: Hardcover auto-assigned a generic edition
  // with an empty edition_format string, but reading_format_id was populated
  // (1 = Read/physical) the whole time.
  assert.equal(
    inferHardcoverMediaType(userBook(), edition({ edition_format: "", reading_format_id: 1 })),
    "physical"
  );
});

test("inferHardcoverMediaType trusts reading_format_id over a mislabeled edition_format", () => {
  // Real Hardcover data can have edition_format text that disagrees with the
  // edition's actual reading_format (crowdsourced, occasionally wrong) —
  // reading_format_id must win.
  assert.equal(
    inferHardcoverMediaType(userBook(), edition({ edition_format: "Audiobook", reading_format_id: 1 })),
    "physical"
  );
});

test("inferHardcoverMediaType maps reading_format_id 2 to audiobook and 4 to ebook", () => {
  assert.equal(inferHardcoverMediaType(userBook(), edition({ reading_format_id: 2 })), "audiobook");
  assert.equal(inferHardcoverMediaType(userBook(), edition({ reading_format_id: 4 })), "ebook");
});

test("inferHardcoverMediaType falls through to default-edition pointers for a dual-format (Both) edition", () => {
  const book = userBook({
    edition_id: 100,
    book: { ...userBook().book, default_audio_edition_id: 100 }
  });
  assert.equal(inferHardcoverMediaType(book, edition({ reading_format_id: 3 })), "audiobook");
});

test("inferHardcoverMediaType returns null when there is no edition data and no matching default pointer", () => {
  assert.equal(inferHardcoverMediaType(userBook({ edition_id: null }), null), null);
});

test("inferHardcoverMediaType never falls back to edition_format, even when reading_format_id is simply absent", () => {
  // Distinct from the "mislabeled" case above (reading_format_id present and
  // disagreeing): here reading_format_id is null outright, so edition_format
  // is the only signal available — it must still never be trusted.
  assert.equal(
    inferHardcoverMediaType(userBook(), edition({ edition_format: "Audiobook", reading_format_id: null })),
    null
  );
});
