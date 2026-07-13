import type { TestResult } from "../../shared/types.js";
import { logger } from "../logger.js";

const HARDCOVER_API = "https://api.hardcover.app/v1/graphql";

export interface HardcoverUserBook {
  id: number;
  edition_id: number | null;
  status_id: number | null;
  rating: number | null;
  updated_at: string | null;
  first_started_reading_date: string | null;
  last_read_date: string | null;
  book: {
    id: number;
    title: string;
    slug: string | null;
    pages?: number | null;
    default_physical_edition_id?: number | null;
    default_ebook_edition_id?: number | null;
    default_audio_edition_id?: number | null;
    image: { url: string } | null;
    contributions: Array<{ author: { name: string } }> | null;
    default_physical_edition: { isbn_13: string | null; isbn_10: string | null; pages?: number | null } | null;
    default_ebook_edition: { asin: string | null; isbn_13: string | null; isbn_10: string | null } | null;
    default_audio_edition: { asin: string | null; isbn_13: string | null; isbn_10: string | null } | null;
    book_series: Array<{
      position: number | string | null;
      series: { name: string | null } | null;
    }> | null;
  };
  user_book_reads: Array<{
    id: number;
    edition_id: number | null;
    edition: { pages: number | null } | null;
    progress: number | null;
    progress_pages: number | null;
    progress_seconds: number | null;
    started_at: string | null;
    finished_at: string | null;
  }> | null;
}

export interface HardcoverEdition {
  id: number;
  edition_format: string | null;
  isbn_13: string | null;
  isbn_10: string | null;
  asin: string | null;
  pages: number | null;
  audio_seconds: number | null;
  image: { url: string } | null;
}

export async function hardcoverQuery<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(HARDCOVER_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "authorization": token
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Hardcover API error: HTTP ${res.status}`);
  const json = await res.json() as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0]?.message ?? "Hardcover GraphQL error");
  return json.data as T;
}

export async function testHardcoverToken(token: string): Promise<TestResult & { username?: string }> {
  if (!token?.trim()) return { ok: false, message: "No API token provided" };
  try {
    const data = await hardcoverQuery<{ me: { id: number; username: string }[] }>(
      token,
      `query { me { id username } }`
    );
    const user = data.me?.[0];
    if (!user) return { ok: false, message: "No user data returned" };
    return { ok: true, message: `Connected as ${user.username}`, username: user.username };
  } catch (err) {
    logger.warn("Hardcover token test failed", { error: err });
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchHardcoverUserId(token: string): Promise<number> {
  const data = await hardcoverQuery<{ me: { id: number }[] }>(token, `query { me { id } }`);
  const user = data.me?.[0];
  if (!user) throw new Error("Could not fetch Hardcover user ID");
  return user.id;
}

const USER_BOOKS_QUERY = `
  query GetUserBooks($userId: Int!, $limit: Int!, $offset: Int!) {
    user_books(
      where: { user_id: { _eq: $userId } }
      order_by: [{ updated_at: desc }]
      limit: $limit
      offset: $offset
    ) {
      id
      edition_id
      status_id
      rating
      updated_at
      first_started_reading_date
      last_read_date
      book {
        id
        title
        slug
        pages
        default_physical_edition_id
        default_ebook_edition_id
        default_audio_edition_id
        image { url }
        contributions { author { name } }
        default_physical_edition { isbn_13 isbn_10 pages }
        default_ebook_edition { asin isbn_13 isbn_10 }
        default_audio_edition { asin isbn_13 isbn_10 }
        book_series {
          position
          series { name }
        }
      }
      user_book_reads(order_by: [{ id: desc }], limit: 5) {
        id
        edition_id
        edition { pages }
        progress
        progress_pages
        progress_seconds
        started_at
        finished_at
      }
    }
  }
`;

const EDITIONS_QUERY = `
  query GetEditions($editionIds: [Int!]) {
    editions(where: { id: { _in: $editionIds } }) {
      id
      edition_format
      isbn_13
      isbn_10
      asin
      pages
      audio_seconds
      image { url }
    }
  }
`;

export async function fetchHardcoverLibrary(token: string, userId: number): Promise<HardcoverUserBook[]> {
  const allBooks: HardcoverUserBook[] = [];
  const BATCH = 250;
  let offset = 0;

  while (true) {
    const data = await hardcoverQuery<{ user_books: HardcoverUserBook[] }>(
      token,
      USER_BOOKS_QUERY,
      { userId, limit: BATCH, offset }
    );
    const batch = data.user_books ?? [];
    allBooks.push(...batch);
    logger.info("Hardcover library batch fetched", { userId, offset, count: batch.length });
    if (batch.length < BATCH) break;
    offset += BATCH;
  }

  // Deduplicate by book.id, keeping the most recently updated entry
  const seen = new Map<number, HardcoverUserBook>();
  for (const ub of allBooks) {
    const existing = seen.get(ub.book.id);
    if (!existing || (ub.updated_at ?? "") > (existing.updated_at ?? "")) {
      seen.set(ub.book.id, ub);
    }
  }

  return Array.from(seen.values());
}

export async function fetchHardcoverEditions(token: string, editionIds: number[]): Promise<Map<number, HardcoverEdition>> {
  const uniqueIds = Array.from(new Set(editionIds.filter((id) => Number.isFinite(id) && id > 0)));
  if (uniqueIds.length === 0) return new Map();

  const data = await hardcoverQuery<{ editions: HardcoverEdition[] }>(
    token,
    EDITIONS_QUERY,
    { editionIds: uniqueIds }
  );

  return new Map((data.editions ?? []).map((edition) => [edition.id, edition]));
}

const BOOK_EDITIONS_QUERY = `
  query GetBookEditions($bookId: Int!) {
    books(where: { id: { _eq: $bookId } }) {
      editions(order_by: [{ users_count: desc }]) {
        id
        pages
        users_count
      }
    }
  }
`;

/** Fetch all editions for a single book, ordered by popularity. Used for lazy edition resolution. */
export async function fetchEditionsForBook(
  token: string,
  bookId: number
): Promise<Array<{ id: number; pages: number | null; users_count: number | null }>> {
  const data = await hardcoverQuery<{
    books: Array<{ editions: Array<{ id: number; pages: number | null; users_count: number | null }> }>
  }>(token, BOOK_EDITIONS_QUERY, { bookId });
  return data.books?.[0]?.editions ?? [];
}

const UPDATE_USER_BOOK_MUTATION = `
  mutation UpdateUserBook($id: Int!, $object: UserBookUpdateInput!) {
    update_user_book(id: $id, object: $object) {
      id
      error
    }
  }
`;

const INSERT_USER_BOOK_MUTATION = `
  mutation InsertUserBook($object: UserBookCreateInput!) {
    insert_user_book(object: $object) {
      id
      error
    }
  }
`;

const INSERT_LIST_BOOK_MUTATION = `
  mutation InsertListBook($object: ListBookInput!) {
    insert_list_book(object: $object) {
      id
    }
  }
`;

const INSERT_USER_BOOK_READ_MUTATION = `
  mutation InsertUserBookRead($userBookId: Int!, $read: DatesReadInput!) {
    insert_user_book_read(user_book_id: $userBookId, user_book_read: $read) {
      id
      error
    }
  }
`;

const UPDATE_USER_BOOK_READ_MUTATION = `
  mutation UpdateUserBookRead($id: Int!, $object: DatesReadInput!) {
    update_user_book_read(id: $id, object: $object) {
      id
      error
    }
  }
`;

const DELETE_USER_BOOK_READ_MUTATION = `
  mutation DeleteUserBookRead($id: Int!) {
    delete_user_book_read(id: $id) {
      id
      error
    }
  }
`;

const USER_LISTS_QUERY = `
  query GetUserLists {
    me {
      lists {
        id
        name
        slug
        list_books {
          edition {
            id
            edition_format
            isbn_13
            isbn_10
            asin
            pages
            image { url }
          }
          book {
            id
            title
            slug
            pages
            image { url }
            contributions { author { name } }
            default_physical_edition { isbn_13 isbn_10 pages }
            default_ebook_edition { asin isbn_13 isbn_10 }
            default_audio_edition { asin isbn_13 isbn_10 }
            book_series {
              position
              series { name }
            }
          }
        }
      }
    }
  }
`;

const USER_LISTS_QUERY_LEGACY = `
  query GetUserLists {
    me {
      lists {
        id
        name
        slug
        list_books {
          book {
            id
            title
            slug
            pages
            image { url }
            contributions { author { name } }
            default_physical_edition { isbn_13 isbn_10 pages }
            default_ebook_edition { asin isbn_13 isbn_10 }
            default_audio_edition { asin isbn_13 isbn_10 }
            book_series {
              position
              series { name }
            }
          }
        }
      }
    }
  }
`;

export interface HardcoverList {
  id: number;
  name: string;
  slug: string | null;
  bookIds: number[];
  books: HardcoverUserBook["book"][];
  entries: Array<{
    book: HardcoverUserBook["book"];
    editionId: number | null;
    edition: HardcoverEdition | null;
  }>;
}

export async function fetchHardcoverLists(token: string): Promise<HardcoverList[]> {
  let data: {
    me: Array<{
      lists: Array<{
        id: number;
        name: string;
        slug: string | null;
        list_books: Array<{ book: HardcoverUserBook["book"]; edition?: HardcoverEdition | null }>;
      }>;
    }>;
  };

  try {
    data = await hardcoverQuery(token, USER_LISTS_QUERY);
  } catch (err) {
    logger.warn("Hardcover lists query with edition metadata failed; retrying legacy list query", { error: err });
    data = await hardcoverQuery(token, USER_LISTS_QUERY_LEGACY);
  }

  const user = data.me?.[0];
  if (!user) return [];
  return (user.lists ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    slug: l.slug,
    bookIds: (l.list_books ?? []).map((lb) => lb.book.id),
    books: (l.list_books ?? []).map((lb) => lb.book),
    entries: (l.list_books ?? []).map((lb) => ({
      book: lb.book,
      editionId: lb.edition?.id ?? null,
      edition: lb.edition ?? null
    }))
  }));
}

export async function updateHardcoverUserBook(
  token: string,
  userBookId: number,
  fields: { status_id?: number; edition_id?: number | null; rating?: number; last_read_date?: string | null }
): Promise<void> {
  await hardcoverQuery<unknown>(token, UPDATE_USER_BOOK_MUTATION, { id: userBookId, object: fields });
}

export async function insertHardcoverUserBook(
  token: string,
  fields: { book_id: number; status_id?: number; edition_id?: number | null; rating?: number; last_read_date?: string | null }
): Promise<number> {
  const data = await hardcoverQuery<{ insert_user_book: { id: number; error?: string | null } }>(
    token,
    INSERT_USER_BOOK_MUTATION,
    { object: fields }
  );
  if (data.insert_user_book.error) throw new Error(data.insert_user_book.error);
  return data.insert_user_book.id;
}

export async function addBookToHardcoverList(
  token: string,
  listId: number,
  bookId: number
): Promise<number> {
  const data = await hardcoverQuery<{ insert_list_book: { id: number } }>(
    token,
    INSERT_LIST_BOOK_MUTATION,
    { object: { list_id: listId, book_id: bookId } }
  );
  return data.insert_list_book.id;
}

export type HardcoverReadFields = {
  edition_id?: number | null;
  progress_pages?: number | null;
  progress_seconds?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
  finished_at_precision?: string | null;
};

export async function insertHardcoverUserBookRead(
  token: string,
  userBookId: number,
  fields: HardcoverReadFields
): Promise<number> {
  const data = await hardcoverQuery<{ insert_user_book_read: { id: number; error?: string | null } }>(
    token,
    INSERT_USER_BOOK_READ_MUTATION,
    { userBookId, read: fields }
  );
  if (data.insert_user_book_read.error) throw new Error(data.insert_user_book_read.error);
  return data.insert_user_book_read.id;
}

export async function updateHardcoverUserBookRead(
  token: string,
  readId: number,
  fields: HardcoverReadFields
): Promise<void> {
  const data = await hardcoverQuery<{ update_user_book_read: { id: number; error?: string | null } }>(
    token,
    UPDATE_USER_BOOK_READ_MUTATION,
    { id: readId, object: fields }
  );
  if (data.update_user_book_read.error) throw new Error(data.update_user_book_read.error);
}

export async function deleteHardcoverUserBookRead(
  token: string,
  readId: number
): Promise<void> {
  const data = await hardcoverQuery<{ delete_user_book_read: { id: number; error?: string | null } }>(
    token,
    DELETE_USER_BOOK_READ_MUTATION,
    { id: readId }
  );
  if (data.delete_user_book_read.error) throw new Error(data.delete_user_book_read.error);
}
