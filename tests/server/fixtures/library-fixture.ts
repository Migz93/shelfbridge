import type Database from "better-sqlite3";

export type LibrarySize = "small" | "medium" | "large";

const WORK_COUNTS: Record<LibrarySize, number> = {
  small: 100,
  medium: 1000,
  large: 10000
};

function validIsbn13(n: number): string {
  const body = `978${String(n).padStart(9, "0")}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return `${body}${check}`;
}

const insertSourceSql = `
  INSERT INTO book_sources (
    source_type, source_instance_id, external_id, title, author, isbn13,
    series_name, series_number, source_media_type,
    source_hardcover_book_id, source_goodreads_book_id, grimmory_primary_file_path
  ) VALUES (@sourceType, @sourceInstanceId, @externalId, @title, @author, @isbn13,
    @seriesName, @seriesNumber, 'book', @sourceHardcoverBookId, @sourceGoodreadsBookId, @grimmoryPrimaryFilePath)
`;

/**
 * Seeds `book_sources` with a synthetic library, unreconciled (book_id left
 * NULL), as a fresh sync would leave them. Each "work" gets a Hardcover and a
 * Grimmory row sharing a valid ISBN13 (forcing a real merge, not just row
 * count), plus a Chaptarr row sharing the same on-disk path bucket as the
 * Grimmory row, so reconciling this fixture exercises the same merge passes a
 * real library would, not just the cheapest one.
 */
export function seedLibrary(db: Database.Database, size: LibrarySize): { workCount: number; sourceCount: number } {
  const workCount = WORK_COUNTS[size];
  const insert = db.prepare(insertSourceSql);
  const insertChaptarr = db.prepare(`
    INSERT INTO book_sources (source_type, source_instance_id, external_id, title, author, source_media_type, chaptarr_primary_file_path)
    VALUES ('chaptarr', 0, @externalId, @title, @author, 'book', @path)
  `);
  const transaction = db.transaction(() => {
    for (let i = 0; i < workCount; i++) {
      const isbn = validIsbn13(i + 1);
      const title = `Work ${i}`;
      const author = `Author ${i % 500}`;
      const path = `/library/work-${i}.epub`;
      insert.run({
        sourceType: "hardcover", sourceInstanceId: 1, externalId: `hc-${i}`, title, author, isbn13: isbn,
        seriesName: null, seriesNumber: null, sourceHardcoverBookId: `hc-${i}`, sourceGoodreadsBookId: null,
        grimmoryPrimaryFilePath: null
      });
      insert.run({
        sourceType: "grimmory", sourceInstanceId: 1, externalId: `gr-${i}`, title, author, isbn13: isbn,
        seriesName: null, seriesNumber: null, sourceHardcoverBookId: null, sourceGoodreadsBookId: null,
        grimmoryPrimaryFilePath: path
      });
      insertChaptarr.run({ externalId: `chap-${i}`, title, author, path });
    }
  });
  transaction();
  const sourceCount = (db.prepare("SELECT COUNT(*) AS count FROM book_sources").get() as { count: number }).count;
  return { workCount, sourceCount };
}
