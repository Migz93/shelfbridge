import { logger } from "../logger.js";
import { HARDCOVER_TO_GRIMMORY } from "./matcher.js";
import type { HardcoverReadFields } from "./hardcover.js";

/**
 * Runs Audiobookshelf's three-way progress propagation. The explicit context
 * keeps this phase independent from the top-level sync orchestration.
 */
export async function syncAudiobookshelfProgress(context: any): Promise<void> {
  const {
    db, profileId, runId, hasAbs, hasHardcover, grimmoryAvailable, adapters,
    absBaseUrl, absApiKey, baseUrl, grimmoryToken, hardcoverToken,
    dryRun, counters, grimmoryBooks, grimmoryProgressById, hcBooks, recordEvent,
    meaningfulProgress, effectiveAbsCurrentTimeSeconds, persistResolvedHardcoverAudioEdition,
    clampPercent, shouldBookProgressOwnSharedHardcover, todayDate
  } = context;
// ── Phase N: Audiobookshelf progress sync ────────────────────────────────
// ABS is the source of truth for audiobook listening progress.
// When ABS reports progress for a matched audiobook, push that progress
// outward to Grimmory and Hardcover whenever they differ meaningfully.
if (hasAbs && (hasHardcover || grimmoryAvailable)) {
  try {
    logger.info("Fetching Audiobookshelf progress", { profileId });
        const absProgressList: any[] = await adapters.fetchAudiobookshelfAllProgress(absBaseUrl, absApiKey!);
        const absProgressIndex = new Map<string, any>(absProgressList.map((p: any) => [p.libraryItemId, p]));
    logger.info("Audiobookshelf progress fetched", { profileId, count: absProgressList.length });

    // Get this profile's own ABS book_sources that are linked to a book. Scoped to
    // source_instance_id: absSource.abs_item_id is looked up against this profile's
    // own absProgressIndex below, and an unscoped row from another profile's ABS
    // instance could coincidentally share a local item id with an unrelated book.
    const absSources = db.prepare(`
      SELECT bs.external_id AS abs_item_id, bs.book_id,
             bs.audiobookshelf_duration AS abs_duration,
             bs.audiobookshelf_runtime_validated AS runtime_validated
      FROM book_sources bs
      WHERE bs.source_type = 'audiobookshelf' AND bs.source_instance_id = ? AND bs.book_id IS NOT NULL
    `).all(profileId) as Array<{ abs_item_id: string; book_id: number; abs_duration: number | null; runtime_validated: number | null }>;

    // Build book_id → Grimmory book_id lookup for use inside the loop, scoped to
    // this profile's own Grimmory instance (the id is about to be sent back to
    // this profile's Grimmory server).
    const grimmoryIdByBookId = new Map<number, number>();
    if (grimmoryAvailable) {
      (db.prepare(`
        SELECT book_id, CAST(external_id AS INTEGER) AS grimmory_book_id
        FROM book_sources WHERE source_type = 'grimmory' AND source_instance_id = ? AND book_id IS NOT NULL
      `).all(profileId) as Array<{ book_id: number; grimmory_book_id: number }>).forEach((row) => {
        grimmoryIdByBookId.set(row.book_id, row.grimmory_book_id);
      });
    }

    for (const absSource of absSources) {
      const absProgress = absProgressIndex.get(absSource.abs_item_id);

      // HC user state (if HC configured)
      const hcState = hasHardcover ? db.prepare(`
        SELECT hardcover_updated_at, progress, progress_seconds, hardcover_status_id, hardcover_read_id,
               hardcover_user_book_id, hardcover_edition_id
        FROM user_book_states
        WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'
      `).get(absSource.book_id, profileId) as {
        hardcover_updated_at: string | null;
        progress: number | null;
        progress_seconds: number | null;
        hardcover_status_id: number | null;
        hardcover_read_id: number | null;
        hardcover_user_book_id: number | null;
        hardcover_edition_id: number | null;
      } | undefined : undefined;

      // HC audio_seconds/edition from book_sources (used for mismatch logging
      // and to detect when Hardcover's "current edition" pointer has drifted
      // away from the edition we're actually tracking progress against). Scoped
      // to this profile's own Hardcover instance — each profile can track a
      // different edition of the same book.
      const hcAudioSecondsRow = hasHardcover ? db.prepare(`
        SELECT hardcover_audio_seconds, source_edition_id, external_id FROM book_sources
        WHERE source_type = 'hardcover' AND source_instance_id = ? AND book_id = ?
      `).get(profileId, absSource.book_id) as { hardcover_audio_seconds: number | null; source_edition_id: string | null; external_id: string } | undefined : undefined;
      const hcAudioSeconds = hcAudioSecondsRow?.hardcover_audio_seconds ?? null;
      const persistedAudioEditionId = hcAudioSecondsRow?.source_edition_id != null
        ? Number.parseInt(hcAudioSecondsRow.source_edition_id, 10)
        : null;
      // Hardcover's own live "current edition" pointer for this book right
      // now — compared against our persisted target below to detect drift
      // even when our local cache still (correctly) remembers audio.
      const liveHcBookForEdition = hcAudioSecondsRow
        ? hcBooks.find((b: any) => String(b.book.id) === hcAudioSecondsRow.external_id)
        : undefined;
      if (absSource.abs_duration && hcAudioSeconds && hcAudioSeconds > 0) {
        const delta = Math.abs(absSource.abs_duration - hcAudioSeconds) / hcAudioSeconds;
        if (delta > 0.05) {
          logger.warn("ABS/HC audio duration mismatch — HC edition may be wrong", {
            profileId, bookId: absSource.book_id, absDuration: absSource.abs_duration, hcAudioSeconds, deltaPct: Math.round(delta * 100)
          });
        }
      }

      // Grimmory data for this book (if Grimmory available)
      const grimmoryBookId = grimmoryIdByBookId.get(absSource.book_id) ?? null;
      const grimProgressData = grimmoryBookId !== null ? grimmoryProgressById.get(grimmoryBookId) : undefined;
      const grBook = grimmoryBookId !== null ? grimmoryBooks.find((b: any) => b.id === grimmoryBookId) : undefined;
      const grProgress = meaningfulProgress(grimProgressData?.readProgress ?? null); // 0–100
      const bookOwnsSharedHardcover = grBook?.mediaType === "audiobook"
        && shouldBookProgressOwnSharedHardcover(grimmoryBooks, grBook.hardcoverBookId);

      const absDuration = absSource.abs_duration ?? (absProgress?.duration ?? null);
      const hcProgressPct = hcState?.progress_seconds && absDuration && absDuration > 0
        ? meaningfulProgress((hcState.progress_seconds / absDuration) * 100)
        : null;
      const storedHcProgress = meaningfulProgress(hcState?.progress ?? null);
      const effectiveHcProgress = storedHcProgress !== null
        ? storedHcProgress
        : hcProgressPct;
      const absSourcePct = absProgress ? clampPercent(absProgress.progress * 100) : null;

      // Backfill duration on book_sources if not yet stored (ABS item metadata may return 0).
      // Scoped to this profile's own ABS instance — a colliding item id on another
      // profile's ABS server must not have its duration overwritten.
      if (absDuration !== null && absDuration > 0 && !absSource.abs_duration) {
        db.prepare(
          "UPDATE book_sources SET audiobookshelf_duration = ? WHERE source_type = 'audiobookshelf' AND source_instance_id = ? AND external_id = ?"
        ).run(Math.round(absDuration), profileId, absSource.abs_item_id);
      }

      // Upsert ABS user state regardless of progress sync eligibility
      if (absProgress) {
        const absProgressPct = absProgress.progress * 100;
        const absUpdatedAt = new Date(absProgress.lastUpdate).toISOString();
        const absCurrentTimeSeconds = effectiveAbsCurrentTimeSeconds(absProgress, absDuration);
        db.prepare(`
          DELETE FROM user_book_states
          WHERE profile_id = ?
            AND source_type = 'audiobookshelf'
            AND audiobookshelf_item_id = ?
            AND book_id <> ?
        `).run(profileId, absSource.abs_item_id, absSource.book_id);
        const prevAbsState = db.prepare(
          "SELECT id, progress FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'audiobookshelf'"
        ).get(absSource.book_id, profileId) as { id: number; progress: number | null } | undefined;

        if (prevAbsState) {
          db.prepare(`
            UPDATE user_book_states
            SET progress = ?, audiobookshelf_item_id = ?, audiobookshelf_current_time = ?,
                audiobookshelf_duration = ?, audiobookshelf_updated_at = ?,
                last_modified_at = datetime('now'), last_sync_at = datetime('now')
            WHERE book_id = ? AND profile_id = ? AND source_type = 'audiobookshelf'
          `).run(
            absProgressPct, absSource.abs_item_id,
            absCurrentTimeSeconds,
            absDuration !== null ? Math.round(absDuration) : null,
            absUpdatedAt,
            absSource.book_id, profileId
          );
        } else {
          db.prepare(`
            INSERT INTO user_book_states
              (book_id, profile_id, source_type, progress, audiobookshelf_item_id,
               audiobookshelf_current_time, audiobookshelf_duration, audiobookshelf_updated_at,
               sync_health, last_sync_at, last_modified_at)
            VALUES (?, ?, 'audiobookshelf', ?, ?, ?, ?, ?, 'synced', datetime('now'), datetime('now'))
          `).run(
            absSource.book_id, profileId, absProgressPct, absSource.abs_item_id,
            absCurrentTimeSeconds,
            absDuration !== null ? Math.round(absDuration) : null,
            absUpdatedAt
          );
        }
      }

      // ABS-driven progress sync — only when runtime is validated, duration is
      // known, and ABS actually reports a progress value for the item.
      if (!absSource.runtime_validated) continue;
      if (absDuration === null || absDuration <= 0) continue;
      if (absSourcePct === null) continue;
      const needsWrite = (targetPct: number | null): boolean =>
        targetPct === null ? absSourcePct > 0 : Math.abs(absSourcePct - targetPct) >= 0.1;
      // ABS is the source of truth for audiobook status too — 98%+ counts as
      // finished. This overrides whatever status Hardcover or Grimmory
      // currently have stored, since both can drift (e.g. a stale Hardcover
      // status left over from before the two editions were linked correctly).
      const absDesiredStatusId = absSourcePct >= 98 ? 3 : 2;
      const absDesiredGrimmoryStatus = HARDCOVER_TO_GRIMMORY[absDesiredStatusId];

      // ── Write to Grimmory ──
      if (grBook?.primaryFileId && grimmoryToken && needsWrite(grProgress)) {
        const direction = "abs_to_grimmory";
        const decision = "abs_newer_progress";
        if (!dryRun) {
          try {
            await adapters.updateGrimmoryProgress(baseUrl, grimmoryToken, grBook.id, grBook.primaryFileId, absSourcePct);
            logger.info("Wrote progress to Grimmory", { profileId, bookId: absSource.book_id, source: "abs", pct: absSourcePct });
            recordEvent(db, runId, profileId, grBook.title ?? "", "written", direction, decision, { pct: absSourcePct });
            counters.written++;
          } catch (writeErr) {
            logger.warn("Failed to write progress to Grimmory", { profileId, bookId: absSource.book_id, source: "abs", error: writeErr });
            counters.skipped++;
          }
        } else {
          recordEvent(db, runId, profileId, grBook.title ?? "", "written", direction, decision, { pct: absSourcePct, dryRun: true });
          counters.written++;
        }
      }

      // ── Write status to Grimmory (ABS-derived) ──
      if (grBook && grimmoryToken && absDesiredGrimmoryStatus && grBook.readStatus !== absDesiredGrimmoryStatus) {
        const direction = "abs_to_grimmory";
        const decision = "abs_derived_status";
        if (!dryRun) {
          try {
            await adapters.updateGrimmoryStatus(baseUrl, grimmoryToken, grBook.id, absDesiredGrimmoryStatus);
            logger.info("Wrote ABS-derived status to Grimmory", { profileId, bookId: absSource.book_id, status: absDesiredGrimmoryStatus, pct: absSourcePct });
            recordEvent(db, runId, profileId, grBook.title ?? "", "written", direction, decision, { status: absDesiredGrimmoryStatus, pct: absSourcePct });
            counters.written++;
          } catch (writeErr) {
            logger.warn("Failed to write ABS-derived status to Grimmory", { profileId, bookId: absSource.book_id, error: writeErr });
            counters.skipped++;
          }
        } else {
          recordEvent(db, runId, profileId, grBook.title ?? "", "written", direction, decision, { status: absDesiredGrimmoryStatus, pct: absSourcePct, dryRun: true });
          counters.written++;
        }
      }

      // ── Write to Hardcover ──
      if (bookOwnsSharedHardcover) {
        logger.info("Skipped ABS-to-Hardcover progress write because book edition owns shared Hardcover progress", {
          profileId,
          bookId: absSource.book_id,
          grimmoryBookId: grBook?.id ?? null,
          pct: absSourcePct
        });
        recordEvent(db, runId, profileId, grBook?.title ?? "", "skipped_no_change", "abs_to_hardcover", "book_progress_wins_shared_hardcover", {
          pct: absSourcePct,
          grimmoryBookId: grBook?.id ?? null
        });
        counters.skipped++;
        continue;
      }

      // Also re-enter when only the status is stale (e.g. progress already
      // matches within tolerance but Hardcover's status_id is left over from
      // before this book's audiobook/print editions were linked correctly) —
      // otherwise a wrong status can never self-correct once progress settles.
      const hcStatusNeedsCorrection = hasHardcover && hcState?.hardcover_status_id !== absDesiredStatusId;
      // Also re-enter when Hardcover's "current edition" pointer for this
      // shared book has drifted off the audio edition (e.g. touching any
      // other read on it flips this) even though progress/status content
      // already match — otherwise Hardcover keeps showing the wrong
      // edition (and its unrelated 0% progress) as "currently reading"
      // even while the actual audio read stays perfectly in sync.
      const hcEditionNeedsCorrection = hasHardcover
        && Number.isFinite(persistedAudioEditionId)
        && liveHcBookForEdition !== undefined
        && liveHcBookForEdition.edition_id !== persistedAudioEditionId;
      if (needsWrite(effectiveHcProgress) || hcStatusNeedsCorrection || hcEditionNeedsCorrection) {
        const hcSourceRow = hasHardcover ? db.prepare(`
          SELECT external_id, source_edition_id, source_media_type, source_audible_asin, hardcover_audio_seconds
          FROM book_sources
          WHERE source_type = 'hardcover' AND source_instance_id = ? AND book_id = ?
        `).get(profileId, absSource.book_id) as {
          external_id: string;
          source_edition_id: string | number | null;
          source_media_type: string | null;
          source_audible_asin: string | null;
          hardcover_audio_seconds: number | null;
        } | undefined : undefined;
        // Scoped to this profile's own Grimmory/ABS instances — these values feed a
        // Hardcover edition lookup made through this profile's own Hardcover token,
        // so another profile's cross-reference data must not leak in.
        const audiobookIdentityRow = db.prepare(`
          SELECT
            MAX(CASE WHEN source_type = 'grimmory' AND source_instance_id = ? THEN source_hardcover_book_id END) AS grimmory_hardcover_book_id,
            MAX(CASE WHEN source_type = 'grimmory' AND source_instance_id = ? THEN source_audible_asin END) AS grimmory_audible_asin,
            MAX(CASE WHEN source_type = 'audiobookshelf' AND source_instance_id = ? THEN audiobookshelf_asin END) AS audiobookshelf_asin
          FROM book_sources
          WHERE book_id = ?
        `).get(profileId, profileId, profileId, absSource.book_id) as {
          grimmory_hardcover_book_id: string | null;
          grimmory_audible_asin: string | null;
          audiobookshelf_asin: string | null;
        } | undefined;
        const parsedHcBookId = hcSourceRow
          ? parseInt(hcSourceRow.external_id, 10)
          : (audiobookIdentityRow?.grimmory_hardcover_book_id
              ? parseInt(audiobookIdentityRow.grimmory_hardcover_book_id, 10)
              : null);
        const hcBookId = parsedHcBookId !== null && Number.isFinite(parsedHcBookId) ? parsedHcBookId : null;
        const hcLibraryBook = hcBookId !== null ? hcBooks.find((book: any) => book.book.id === hcBookId) : undefined;
        let preferredEditionId: number | null = null;
        const desiredStatusId = absDesiredStatusId;

        if (hcSourceRow?.source_edition_id != null && hcSourceRow.source_media_type === "audiobook") {
          preferredEditionId = parseInt(String(hcSourceRow.source_edition_id), 10) || null;
        }

        if (!preferredEditionId && hardcoverToken && hcBookId !== null) {
          try {
            const candidateAsins = new Set([
              audiobookIdentityRow?.audiobookshelf_asin,
              audiobookIdentityRow?.grimmory_audible_asin,
              hcSourceRow?.source_audible_asin
            ].filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim().toLowerCase()));
            const editions = await adapters.fetchEditionsForBook(hardcoverToken, hcBookId);
            const asinMatch = editions.find((edition: any) => edition.asin && candidateAsins.has(edition.asin.trim().toLowerCase()));
            const runtimeMatch = !asinMatch && absDuration
              ? editions.find((edition: any) => edition.audio_seconds && Math.abs(edition.audio_seconds - absDuration) / absDuration <= 0.05)
              : undefined;
            const formatMatch = !asinMatch && !runtimeMatch
              ? editions.find((edition: any) => edition.edition_format?.toLowerCase().includes("audio"))
              : undefined;
            preferredEditionId = asinMatch?.id ?? runtimeMatch?.id ?? formatMatch?.id ?? null;
            if (preferredEditionId) {
              logger.info("Resolved Hardcover audio edition for ABS progress", {
                profileId,
                bookId: absSource.book_id,
                hcBookId,
                preferredEditionId,
                matchedBy: asinMatch ? "asin" : runtimeMatch ? "duration" : "format"
              });
            }
          } catch (editionErr) {
            logger.warn("Failed to resolve Hardcover audio edition for ABS progress", {
              profileId,
              bookId: absSource.book_id,
              hcBookId,
              error: editionErr
            });
          }
        }
        if (!preferredEditionId) {
          preferredEditionId = hcLibraryBook?.book.default_audio_edition_id ?? null;
        }

        persistResolvedHardcoverAudioEdition(db, profileId, absSource.book_id, preferredEditionId);

        if (hcState?.hardcover_user_book_id) {
          const progressSeconds = absProgress
            ? effectiveAbsCurrentTimeSeconds(absProgress, absDuration)
            : Math.round((absSourcePct / 100) * (absDuration ?? 0));
          const direction = "abs_to_hardcover";
          const decision = "abs_newer_progress";
          const desiredStatusText = desiredStatusId === 3 ? "READ" : "READING";
          const readFields: HardcoverReadFields = {
            edition_id: preferredEditionId ?? undefined,
            progress_pages: 0,
            progress_seconds: progressSeconds,
            started_at: todayDate(),
            finished_at: null,
            finished_at_precision: null
          };
          if (!dryRun) {
            try {
              // Only patch edition_id/status_id when they actually differ —
              // Hardcover appears to auto-start a fresh blank read whenever
              // edition_id is (re)patched, even to its current value, which
              // would otherwise pile up a new empty read on every sync run.
              // Compare against Hardcover's live current edition (not just
              // our local cache) since that pointer can drift on its own
              // between syncs without our cache knowing.
              const userBookPatch: { edition_id?: number | null; status_id?: number } = {};
              if (preferredEditionId && preferredEditionId !== (liveHcBookForEdition?.edition_id ?? hcState.hardcover_edition_id)) {
                userBookPatch.edition_id = preferredEditionId;
              }
              if (hcState.hardcover_status_id !== desiredStatusId) userBookPatch.status_id = desiredStatusId;
              if (Object.keys(userBookPatch).length > 0) {
                await adapters.updateHardcoverUserBook(hardcoverToken, hcState.hardcover_user_book_id, userBookPatch);
              }
              // Our cached hardcover_read_id can go stale — e.g. Hardcover
              // auto-creates a fresh blank read when status_id changes, or an
              // older read simply ages out / gets removed. Verify it's still
              // live before updating it; blindly updating a read id Hardcover
              // no longer recognizes silently no-ops, leaving the actually
              // displayed (blank) read at 0% forever. Fall back to an existing
              // open read on the target edition, then to inserting a new one.
              const liveReads = hcLibraryBook?.user_book_reads ?? [];
              const cachedReadStillLive = hcState.hardcover_read_id != null
                && liveReads.some((read: any) => read.id === hcState.hardcover_read_id);
              const targetReadId = cachedReadStillLive
                ? hcState.hardcover_read_id
                : liveReads.find((read: any) => read.edition_id === preferredEditionId && read.finished_at === null)?.id ?? null;

              if (targetReadId) {
                await adapters.updateHardcoverUserBookRead(hardcoverToken, targetReadId, readFields);
                if (targetReadId !== hcState.hardcover_read_id) {
                  logger.info("Re-pointed Hardcover read to live record after stale/missing cached read id", {
                    profileId, bookId: absSource.book_id, staleReadId: hcState.hardcover_read_id, targetReadId
                  });
                  db.prepare("UPDATE user_book_states SET hardcover_read_id = ? WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'")
                    .run(targetReadId, absSource.book_id, profileId);
                }
              } else {
                const newReadId = await adapters.insertHardcoverUserBookRead(hardcoverToken, hcState.hardcover_user_book_id, readFields);
                db.prepare("UPDATE user_book_states SET hardcover_read_id = ? WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'")
                  .run(newReadId, absSource.book_id, profileId);
              }
              db.prepare(`
                UPDATE user_book_states
                SET status = ?, progress = NULL, progress_seconds = ?, hardcover_status_id = ?,
                    hardcover_edition_id = COALESCE(?, hardcover_edition_id),
                    last_sync_at = datetime('now'), last_sync_decision = ?
                WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'
              `).run(desiredStatusText, progressSeconds, desiredStatusId, preferredEditionId, decision, absSource.book_id, profileId);
              logger.info("Wrote audio progress to Hardcover", { profileId, bookId: absSource.book_id, source: "abs", pct: absSourcePct, progressSeconds, preferredEditionId });
              recordEvent(db, runId, profileId, "", "written", direction, decision, { pct: absSourcePct, progressSeconds, preferredEditionId });
              counters.written++;
            } catch (writeErr) {
              logger.warn("Failed to write audio progress to Hardcover", { profileId, bookId: absSource.book_id, source: "abs", error: writeErr });
              counters.skipped++;
            }
          } else {
            recordEvent(db, runId, profileId, "", "written", direction, decision, { pct: absSourcePct, progressSeconds, preferredEditionId, dryRun: true });
            counters.written++;
          }
        } else if (hardcoverToken) {
          // No valid user_book_id yet. If Grimmory/ABS can identify the HC book,
          // create an audiobook user_book/read so future syncs have a local state.
          if (hcBookId !== null) {
            const progressSeconds = absProgress
              ? effectiveAbsCurrentTimeSeconds(absProgress, absDuration)
              : Math.round((absSourcePct / 100) * (absDuration ?? 0));
            const direction = "abs_to_hardcover";
            const decision = "abs_newer_progress";
            if (!dryRun) {
              try {
                const desiredStatusText = desiredStatusId === 3 ? "READ" : "READING";
                const newUserBookId = await adapters.insertHardcoverUserBook(hardcoverToken, {
                  book_id: hcBookId,
                  status_id: desiredStatusId,
                  edition_id: preferredEditionId ?? undefined
                });
                const newReadId = await adapters.insertHardcoverUserBookRead(hardcoverToken, newUserBookId, {
                  edition_id: preferredEditionId ?? undefined,
                  progress_pages: 0,
                  progress_seconds: progressSeconds,
                  started_at: todayDate(),
                  finished_at: null,
                  finished_at_precision: null
                });
                db.prepare(`
                  INSERT INTO user_book_states
                    (book_id, profile_id, source_type, status, progress, progress_pages,
                     progress_seconds, sync_health, hardcover_status_id, hardcover_read_id,
                     hardcover_user_book_id, hardcover_edition_id, last_sync_at,
                     last_sync_decision, last_modified_at)
                  VALUES (?, ?, 'hardcover', ?, NULL, 0, ?, 'synced', ?, ?, ?, ?,
                          datetime('now'), ?, datetime('now'))
                  ON CONFLICT(book_id, profile_id, source_type) DO UPDATE SET
                    status = excluded.status,
                    progress = NULL,
                    progress_pages = 0,
                    progress_seconds = excluded.progress_seconds,
                    sync_health = 'synced',
                    hardcover_status_id = excluded.hardcover_status_id,
                    hardcover_read_id = excluded.hardcover_read_id,
                    hardcover_user_book_id = excluded.hardcover_user_book_id,
                    hardcover_edition_id = excluded.hardcover_edition_id,
                    last_sync_at = datetime('now'),
                    last_sync_decision = excluded.last_sync_decision,
                    last_modified_at = datetime('now')
                `).run(
                  absSource.book_id, profileId, desiredStatusText, progressSeconds, desiredStatusId,
                  newReadId, newUserBookId, preferredEditionId, decision
                );
                logger.info("Created HC user_book and wrote audio progress", {
                  profileId, bookId: absSource.book_id, hcBookId, newUserBookId, preferredEditionId, statusId: desiredStatusId, progressSeconds
                });
                recordEvent(db, runId, profileId, "", "written", direction, decision, { pct: absSourcePct, progressSeconds, preferredEditionId, createdUserBook: true });
                counters.written++;
              } catch (writeErr) {
                logger.warn("Failed to create HC user_book for audio progress", {
                  profileId, bookId: absSource.book_id, hcBookId, error: writeErr
                });
                counters.skipped++;
              }
            } else {
              recordEvent(db, runId, profileId, "", "written", direction, decision, { pct: absSourcePct, progressSeconds, preferredEditionId, createdUserBook: true, dryRun: true });
              counters.written++;
            }
          } else {
            // Book has no HC match — cannot write
            recordEvent(db, runId, profileId, "", "skipped_no_change", "abs_to_hardcover", "hc_book_id_missing", { pct: absSourcePct });
            counters.skipped++;
          }
        } else {
          recordEvent(db, runId, profileId, "", "skipped_no_change", "abs_to_hardcover", "hc_user_book_id_missing", { pct: absSourcePct });
          counters.skipped++;
        }
      }
    }
  } catch (err) {
    logger.warn("Audiobookshelf progress sync failed", { profileId, error: String(err) });
    recordEvent(db, runId, profileId, "Audiobookshelf", "api_failure", "audiobookshelf", "progress_sync_failed", { error: String(err) });
  }
}

}
