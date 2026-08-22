import {
  fetchHardcoverUserId,
  fetchHardcoverLibrary,
  fetchHardcoverEditions,
  fetchHardcoverLists,
  fetchEditionsForBook,
  updateHardcoverUserBook,
  insertHardcoverUserBook,
  addBookToHardcoverList,
  insertHardcoverUserBookRead,
  updateHardcoverUserBookRead,
  deleteHardcoverUserBookRead
} from "./hardcover.js";
import {
  testGrimmoryLogin,
  fetchGrimmoryBooks,
  updateGrimmoryStatus,
  updateGrimmoryRating,
  fetchGrimmoryShelfBookIds,
  fetchGrimmoryShelfList,
  ensureGrimmoryShelf,
  addBooksToGrimmoryShelf,
  fetchGrimmoryProgress,
  updateGrimmoryProgress,
  clearGrimmoryProgress,
  addGrimmoryTag
} from "./grimmory.js";
import { fetchAllGoodreadsBooks, fetchShelfPage } from "./goodreads.js";
import { syncChaptarrStatus } from "./chaptarr.js";
import {
  fetchAudiobookshelfLibraries,
  fetchAudiobookshelfLibraryItems,
  fetchAudiobookshelfAllProgress
} from "./audiobookshelf.js";

/**
 * All network boundaries used by a sync run. Keeping the production clients in
 * one module makes the engine an orchestration layer and lets tests supply
 * fixture-backed adapters without making HTTP requests.
 */
export interface SyncAdapters {
  fetchHardcoverUserId: typeof fetchHardcoverUserId;
  fetchHardcoverLibrary: typeof fetchHardcoverLibrary;
  fetchHardcoverEditions: typeof fetchHardcoverEditions;
  fetchHardcoverLists: typeof fetchHardcoverLists;
  fetchEditionsForBook: typeof fetchEditionsForBook;
  updateHardcoverUserBook: typeof updateHardcoverUserBook;
  insertHardcoverUserBook: typeof insertHardcoverUserBook;
  addBookToHardcoverList: typeof addBookToHardcoverList;
  insertHardcoverUserBookRead: typeof insertHardcoverUserBookRead;
  updateHardcoverUserBookRead: typeof updateHardcoverUserBookRead;
  deleteHardcoverUserBookRead: typeof deleteHardcoverUserBookRead;
  testGrimmoryLogin: typeof testGrimmoryLogin;
  fetchGrimmoryBooks: typeof fetchGrimmoryBooks;
  updateGrimmoryStatus: typeof updateGrimmoryStatus;
  updateGrimmoryRating: typeof updateGrimmoryRating;
  fetchGrimmoryShelfBookIds: typeof fetchGrimmoryShelfBookIds;
  fetchGrimmoryShelfList: typeof fetchGrimmoryShelfList;
  ensureGrimmoryShelf: typeof ensureGrimmoryShelf;
  addBooksToGrimmoryShelf: typeof addBooksToGrimmoryShelf;
  fetchGrimmoryProgress: typeof fetchGrimmoryProgress;
  updateGrimmoryProgress: typeof updateGrimmoryProgress;
  clearGrimmoryProgress: typeof clearGrimmoryProgress;
  addGrimmoryTag: typeof addGrimmoryTag;
  fetchAllGoodreadsBooks: typeof fetchAllGoodreadsBooks;
  fetchShelfPage: typeof fetchShelfPage;
  syncChaptarrStatus: typeof syncChaptarrStatus;
  fetchAudiobookshelfLibraries: typeof fetchAudiobookshelfLibraries;
  fetchAudiobookshelfLibraryItems: typeof fetchAudiobookshelfLibraryItems;
  fetchAudiobookshelfAllProgress: typeof fetchAudiobookshelfAllProgress;
}

export const defaultAdapters: SyncAdapters = {
  fetchHardcoverUserId, fetchHardcoverLibrary, fetchHardcoverEditions,
  fetchHardcoverLists, fetchEditionsForBook, updateHardcoverUserBook,
  insertHardcoverUserBook, addBookToHardcoverList, insertHardcoverUserBookRead,
  updateHardcoverUserBookRead, deleteHardcoverUserBookRead, testGrimmoryLogin,
  fetchGrimmoryBooks, updateGrimmoryStatus, updateGrimmoryRating,
  fetchGrimmoryShelfBookIds, fetchGrimmoryShelfList, ensureGrimmoryShelf, addBooksToGrimmoryShelf,
  fetchGrimmoryProgress, updateGrimmoryProgress, clearGrimmoryProgress,
  addGrimmoryTag, fetchAllGoodreadsBooks, fetchShelfPage, syncChaptarrStatus,
  fetchAudiobookshelfLibraries, fetchAudiobookshelfLibraryItems,
  fetchAudiobookshelfAllProgress
};
