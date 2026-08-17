import { Router } from "express";
import { getDb, getSetting } from "../db/index.js";
import type { AudiobookshelfConnectionView, ConnectionStatus, Profile, ProfileSummary, SyncSettings } from "../../shared/types.js";
import { testGrimmoryLogin, getGrimmoryToken, fetchGrimmoryShelfList } from "../sync/grimmory.js";
import { testHardcoverToken, fetchHardcoverLists } from "../sync/hardcover.js";
import { testGoodreadsUser, fetchGoodreadsCustomShelves } from "../sync/goodreads.js";
import { testAudiobookshelfToken } from "../sync/audiobookshelf.js";
import type { HardcoverListMapping, GoodreadsShelfMapping } from "../../shared/types.js";
import { reconcileBookIdentities } from "../db/bookIdentity.js";
import { logger } from "../logger.js";
import { validateIntegrationUrl } from "../security/outbound.js";
import {
  goodreadsMappingsSchema,
  hardcoverMappingsSchema,
  profileAudiobookshelfTestSchema,
  profileCreateSchema,
  profileGoodreadsTestSchema,
  profileGrimmoryTestSchema,
  profileHardcoverTestSchema,
  profilePatchSchema,
  validationErrorResponse
} from "../validation.js";
import type Database from "better-sqlite3";

const router = Router();

type GoodreadsMappingInput = { goodreadsShelfName: string; grimmoryShelfName: string };
type HardcoverMappingInput = { hardcoverListId: number; hardcoverListName: string; grimmoryShelfName: string };

export function replaceGoodreadsShelfMappings(
  db: Database.Database,
  profileId: number,
  mappings: GoodreadsMappingInput[]
): void {
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM shelf_mappings WHERE profile_id = ? AND source = 'goodreads' AND source_list_id IS NULL").run(profileId);
    const insert = db.prepare(`
      INSERT INTO shelf_mappings (profile_id, source, source_status, source_list_name, grimmory_shelf_name)
      VALUES (?, 'goodreads', ?, ?, ?)
    `);
    for (const mapping of mappings) {
      insert.run(profileId, mapping.goodreadsShelfName, mapping.goodreadsShelfName, mapping.grimmoryShelfName);
    }
  });
  replace();
}

export function replaceHardcoverListMappings(
  db: Database.Database,
  profileId: number,
  mappings: HardcoverMappingInput[]
): void {
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM shelf_mappings WHERE profile_id = ? AND source = 'hardcover' AND source_list_id IS NOT NULL").run(profileId);
    const insert = db.prepare(`
      INSERT INTO shelf_mappings (profile_id, source, source_status, source_list_id, source_list_name, grimmory_shelf_name)
      VALUES (?, 'hardcover', ?, ?, ?, ?)
    `);
    for (const mapping of mappings) {
      insert.run(profileId, mapping.hardcoverListName, String(mapping.hardcoverListId), mapping.hardcoverListName, mapping.grimmoryShelfName);
    }
  });
  replace();
}

export function parseProfileId(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function profileExists(db: Database.Database, id: number): boolean {
  return Boolean(db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(id));
}

function cleanupHardcoverSourceData(profileId: number): void {
  const db = getDb();
  const result = db.transaction(() => {
    // Delete the HC user state for this profile
    const deleted = db.prepare(`
      DELETE FROM user_book_states WHERE profile_id = ? AND source_type = 'hardcover'
    `).run(profileId).changes;

    // Reset sync_health for Grimmory user states on books that no longer have an HC match
    const detached = db.prepare(`
      UPDATE user_book_states SET
        sync_health = 'missing',
        last_sync_decision = 'hardcover_source_disabled',
        last_modified_at = datetime('now')
      WHERE profile_id = ? AND source_type = 'grimmory'
        AND book_id NOT IN (
          SELECT DISTINCT ubs.book_id FROM user_book_states ubs
          JOIN book_sources bs ON bs.book_id = ubs.book_id AND bs.source_type = 'hardcover'
          WHERE ubs.profile_id = ? AND ubs.source_type = 'grimmory'
        )
    `).run(profileId, profileId).changes;

    db.prepare("DELETE FROM shelf_mappings WHERE profile_id = ? AND source = 'hardcover'").run(profileId);
    return { deleted, detached };
  })();

  reconcileBookIdentities(db);
  logger.info("Cleaned local Hardcover source data after disabling connection", { profileId, ...result });
}

function cleanupGoodreadsSourceData(profileId: number): void {
  const db = getDb();
  const result = db.transaction(() => {
    // Delete the GR user state for this profile
    const deleted = db.prepare(`
      DELETE FROM user_book_states WHERE profile_id = ? AND source_type = 'goodreads'
    `).run(profileId).changes;

    // GR book_sources rows are book-level; leave them in place so the book identity is preserved.
    // Just clean the shelf mappings for this profile.
    db.prepare("DELETE FROM shelf_mappings WHERE profile_id = ? AND source = 'goodreads'").run(profileId);
    return { deleted, detached: 0 };
  })();

  reconcileBookIdentities(db);
  logger.info("Cleaned local Goodreads source data after disabling connection", { profileId, ...result });
}

function buildProfileSummary(profileId: number): ProfileSummary | null {
  const db = getDb();
  const p = db.prepare("SELECT * FROM profiles WHERE id = ?").get(profileId) as DbProfile | undefined;
  if (!p) return null;

  const grimmory = db.prepare("SELECT * FROM grimmory_connections WHERE profile_id = ?").get(profileId) as DbGrimmory | undefined;
  const hardcover = db.prepare("SELECT * FROM hardcover_connections WHERE profile_id = ?").get(profileId) as DbHardcover | undefined;
  const goodreads = db.prepare("SELECT * FROM goodreads_connections WHERE profile_id = ?").get(profileId) as DbGoodreads | undefined;
  const syncSettings = db.prepare("SELECT * FROM sync_settings WHERE profile_id = ?").get(profileId) as DbSyncSettings | undefined;
  const lastRun = db.prepare(
    "SELECT status, started_at FROM sync_runs WHERE profile_id = ? ORDER BY started_at DESC LIMIT 1"
  ).get(profileId) as { status: string; started_at: string } | undefined;
  const bookCount = (db.prepare(
    "SELECT COUNT(DISTINCT book_id) as c FROM user_book_states WHERE profile_id = ?"
  ).get(profileId) as { c: number }).c;
  const missingCount = (db.prepare(`
    SELECT COUNT(DISTINCT ubs.book_id) as c FROM user_book_states ubs
    WHERE ubs.profile_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM book_sources bs WHERE bs.book_id = ubs.book_id AND bs.source_type = 'grimmory'
      )
  `).get(profileId) as { c: number }).c;

  return {
    id: p.id,
    displayName: p.display_name,
    enabled: Boolean(p.enabled),
    createdAt: p.created_at,
    grimmoryStatus: (grimmory?.status as ProfileSummary["grimmoryStatus"]) ?? "missing",
    hardcoverStatus: (hardcover?.status as ProfileSummary["hardcoverStatus"]) ?? "missing",
    goodreadsLinked: Boolean(goodreads?.enabled),
    syncEnabled: Boolean(syncSettings?.schedule_enabled),
    lastSyncAt: lastRun?.started_at ?? null,
    lastSyncStatus: (lastRun?.status as ProfileSummary["lastSyncStatus"]) ?? null,
    bookCount,
    missingCount
  };
}

// GET /api/profiles
router.get("/", (_req, res) => {
  const db = getDb();
  const profiles = db.prepare("SELECT id FROM profiles ORDER BY display_name").all() as { id: number }[];
  const summaries = profiles.map((p) => buildProfileSummary(p.id)).filter(Boolean);
  res.json(summaries);
});

// GET /api/profiles/:id
router.get("/:id", (req, res) => {
  const db = getDb();
  const id = parseInt(req.params["id"] ?? "0", 10);
  const p = db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as DbProfile | undefined;
  if (!p) { res.status(404).json({ error: "Not found" }); return; }

  const grimmory = db.prepare("SELECT * FROM grimmory_connections WHERE profile_id = ?").get(id) as DbGrimmory | undefined;
  const hardcover = db.prepare("SELECT * FROM hardcover_connections WHERE profile_id = ?").get(id) as DbHardcover | undefined;
  const goodreads = db.prepare("SELECT * FROM goodreads_connections WHERE profile_id = ?").get(id) as DbGoodreads | undefined;
  const absConn = db.prepare("SELECT * FROM audiobookshelf_connections WHERE profile_id = ?").get(id) as DbAudiobookshelf | undefined;
  const syncSettings = db.prepare("SELECT * FROM sync_settings WHERE profile_id = ?").get(id) as DbSyncSettings | undefined;

  const absView: AudiobookshelfConnectionView | null = absConn ? {
    id: absConn.id,
    absUsername: absConn.abs_username,
    status: absConn.status as ConnectionStatus,
    lastTestedAt: absConn.last_tested_at,
    lastSuccessAt: absConn.last_success_at,
  } : null;

  const profile: Profile = {
    id: p.id,
    displayName: p.display_name,
    enabled: Boolean(p.enabled),
    createdAt: p.created_at,
    grimmory: grimmory ? {
      id: grimmory.id,
      baseUrl: grimmory.base_url || getSetting("grimmory.baseUrl", ""),
      username: grimmory.username,
      status: grimmory.status as ConnectionStatus,
      lastTestedAt: grimmory.last_tested_at,
      lastSuccessAt: grimmory.last_success_at
    } : null,
    hardcover: hardcover ? {
      id: hardcover.id,
      hardcoverUsername: hardcover.hardcover_username,
      syncListId: hardcover.sync_list_id ? parseInt(hardcover.sync_list_id, 10) : null,
      syncListName: hardcover.sync_list_name,
      targetShelfName: hardcover.target_shelf_name,
      status: hardcover.status as ConnectionStatus,
      lastTestedAt: hardcover.last_tested_at,
      lastSuccessAt: hardcover.last_success_at
    } : null,
    goodreads: goodreads ? {
      id: goodreads.id,
      goodreadsUserId: goodreads.goodreads_user_id,
      goodreadsUsername: goodreads.goodreads_username,
      syncShelfName: goodreads.sync_shelf_name,
      targetShelfName: goodreads.target_shelf_name,
      enabled: Boolean(goodreads.enabled),
      status: goodreads.status as ConnectionStatus,
      lastTestedAt: goodreads.last_tested_at,
      lastSuccessAt: goodreads.last_success_at
    } : null,
    audiobookshelf: absView,
    syncSettings: syncSettings ? {
      id: syncSettings.id,
      syncStatusEnabled: Boolean(syncSettings.sync_status_enabled),
      syncProgressEnabled: Boolean(syncSettings.sync_progress_enabled),
      syncShelvesEnabled: Boolean(syncSettings.sync_shelves_enabled),
      syncGoodreadsEnabled: Boolean(syncSettings.sync_goodreads_enabled),
      syncGoodreadsStatusEnabled: Boolean(syncSettings.sync_goodreads_status_enabled),
      syncGoodreadsShelvesEnabled: Boolean(syncSettings.sync_goodreads_shelves_enabled),
      syncWriteTagEnabled: Boolean(syncSettings.sync_write_tag_enabled),
      conflictStrategy: syncSettings.conflict_strategy as SyncSettings["conflictStrategy"],
      scheduleEnabled: Boolean(syncSettings.schedule_enabled),
      scheduleCron: syncSettings.schedule_cron
    } : null
  };

  res.json(profile);
});

// POST /api/profiles
router.post("/", (req, res) => {
  const parsed = profileCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(validationErrorResponse(parsed.error));
    return;
  }
  const { displayName } = parsed.data;
  const db = getDb();

  const result = db.prepare("INSERT INTO profiles (display_name) VALUES (?)").run(displayName);
  const id = result.lastInsertRowid as number;

  // New users inherit the current global conflict default, then can override it
  // from their own General tab.
  db.prepare(`INSERT INTO sync_settings (profile_id, conflict_strategy, schedule_enabled) VALUES (?, ?, 1)`)
    .run(id, getSetting("sync.conflictStrategy", "latest_wins"));

  res.status(201).json({ id });
});

// PATCH /api/profiles/:id
router.patch("/:id", (req, res) => {
  const id = parseProfileId(req.params["id"]);
  if (id === null) {
    res.status(400).json({ error: "Invalid profile id" });
    return;
  }
  const parsed = profilePatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(validationErrorResponse(parsed.error));
    return;
  }
  const body = parsed.data;
  const db = getDb();
  if (!profileExists(db, id)) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  if (body.displayName !== undefined) {
    db.prepare("UPDATE profiles SET display_name = ? WHERE id = ?").run(body.displayName, id);
  }
  if (body.enabled !== undefined) {
    db.prepare("UPDATE profiles SET enabled = ? WHERE id = ?").run(body.enabled ? 1 : 0, id);
  }

  if (body.grimmory) {
    const g = body.grimmory;
    const existing = db.prepare("SELECT id FROM grimmory_connections WHERE profile_id = ?").get(id);
    if (existing) {
      const updates: string[] = [];
      const vals: unknown[] = [];
      if (g.username !== undefined) { updates.push("username = ?"); vals.push(g.username); }
      if (g.password !== undefined) { updates.push("password = ?"); vals.push(g.password); }
      if (g.baseUrl !== undefined) { updates.push("base_url = ?"); vals.push(validateIntegrationUrl(g.baseUrl)); }
      if (updates.length) {
        updates.push("status = 'untested'");
        vals.push(id);
        db.prepare(`UPDATE grimmory_connections SET ${updates.join(", ")} WHERE profile_id = ?`).run(...vals);
      }
    } else {
      db.prepare(`INSERT INTO grimmory_connections (profile_id, username, password, base_url) VALUES (?, ?, ?, ?)`)
        .run(id, g.username ?? "", g.password ?? "", g.baseUrl === undefined ? "" : validateIntegrationUrl(g.baseUrl));
    }
    logger.info("Updated Grimmory connection", { profileId: id });
  }

  if (body.hardcover) {
    const h = body.hardcover;
    if (h.enabled === false) {
      db.prepare("DELETE FROM hardcover_connections WHERE profile_id = ?").run(id);
      cleanupHardcoverSourceData(id);
      logger.info("Removed Hardcover connection", { profileId: id });
    } else {
    const existing = db.prepare("SELECT id FROM hardcover_connections WHERE profile_id = ?").get(id);
    if (existing) {
      const updates: string[] = [];
      const vals: unknown[] = [];
      if (h.apiToken !== undefined) { updates.push("api_token = ?", "status = 'untested'"); vals.push(h.apiToken); }
      if (h.syncListId !== undefined) { updates.push("sync_list_id = ?"); vals.push(h.syncListId ? String(h.syncListId) : null); }
      if (h.syncListName !== undefined) { updates.push("sync_list_name = ?"); vals.push(h.syncListName?.trim() || null); }
      if (h.targetShelfName !== undefined) { updates.push("target_shelf_name = ?"); vals.push(h.targetShelfName?.trim() || null); }
      if (updates.length) {
        vals.push(id);
        db.prepare(`UPDATE hardcover_connections SET ${updates.join(", ")} WHERE profile_id = ?`).run(...vals);
      }
    } else {
      if (!h.apiToken) {
        res.status(400).json({ error: "Hardcover API token is required to enable Hardcover" });
        return;
      }
      db.prepare(`
        INSERT INTO hardcover_connections (profile_id, api_token, sync_list_id, sync_list_name, target_shelf_name)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, h.apiToken ?? "", h.syncListId ? String(h.syncListId) : null, h.syncListName?.trim() || null, h.targetShelfName?.trim() || null);
    }
    logger.info("Updated Hardcover connection", { profileId: id });
    }
  }

  if (body.goodreads) {
    const gr = body.goodreads;
    const existing = db.prepare("SELECT id FROM goodreads_connections WHERE profile_id = ?").get(id);
    if (existing) {
      const updates: string[] = [];
      const vals: unknown[] = [];
      if (gr.goodreadsUserId !== undefined) { updates.push("goodreads_user_id = ?", "status = 'untested'"); vals.push(gr.goodreadsUserId); }
      if (gr.enabled !== undefined) { updates.push("enabled = ?"); vals.push(gr.enabled ? 1 : 0); }
      if (gr.syncShelfName !== undefined) { updates.push("sync_shelf_name = ?"); vals.push(gr.syncShelfName?.trim() || null); }
      if (gr.targetShelfName !== undefined) { updates.push("target_shelf_name = ?"); vals.push(gr.targetShelfName?.trim() || null); }
      if (updates.length) {
        vals.push(id);
        db.prepare(`UPDATE goodreads_connections SET ${updates.join(", ")} WHERE profile_id = ?`).run(...vals);
      }
      if (gr.enabled === false) cleanupGoodreadsSourceData(id);
    } else {
      db.prepare(`
        INSERT INTO goodreads_connections (profile_id, goodreads_user_id, enabled, sync_shelf_name, target_shelf_name)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        id, gr.goodreadsUserId ?? "", gr.enabled ? 1 : 0, gr.syncShelfName?.trim() || null, gr.targetShelfName?.trim() || null
      );
      if (gr.enabled === false) cleanupGoodreadsSourceData(id);
    }
  }

  if (body.audiobookshelf) {
    const abs = body.audiobookshelf;
    if (abs.enabled === false) {
      db.prepare("DELETE FROM audiobookshelf_connections WHERE profile_id = ?").run(id);
      db.prepare(`
        DELETE FROM user_book_states WHERE profile_id = ? AND source_type = 'audiobookshelf'
      `).run(id);
      logger.info("Removed Audiobookshelf connection", { profileId: id });
    } else if (abs.apiKey !== undefined) {
      const existing = db.prepare("SELECT id FROM audiobookshelf_connections WHERE profile_id = ?").get(id);
      if (existing) {
        db.prepare(`
          UPDATE audiobookshelf_connections SET api_key = ?, status = 'untested' WHERE profile_id = ?
        `).run(abs.apiKey, id);
      } else {
        db.prepare(`
          INSERT INTO audiobookshelf_connections (profile_id, api_key) VALUES (?, ?)
        `).run(id, abs.apiKey);
      }
      logger.info("Updated Audiobookshelf connection", { profileId: id });
    }
  }

  if (body.syncSettings) {
    const ss = body.syncSettings;
    const existing = db.prepare("SELECT id FROM sync_settings WHERE profile_id = ?").get(id);
    if (!existing) db.prepare("INSERT INTO sync_settings (profile_id) VALUES (?)").run(id);
    const updates: string[] = [];
    const vals: unknown[] = [];
    if (ss.syncStatusEnabled !== undefined) { updates.push("sync_status_enabled = ?"); vals.push(ss.syncStatusEnabled ? 1 : 0); }
    if (ss.syncProgressEnabled !== undefined) { updates.push("sync_progress_enabled = ?"); vals.push(ss.syncProgressEnabled ? 1 : 0); }
    if (ss.syncShelvesEnabled !== undefined) { updates.push("sync_shelves_enabled = ?"); vals.push(ss.syncShelvesEnabled ? 1 : 0); }
    if (ss.syncGoodreadsEnabled !== undefined) { updates.push("sync_goodreads_enabled = ?"); vals.push(ss.syncGoodreadsEnabled ? 1 : 0); }
    if (ss.syncGoodreadsStatusEnabled !== undefined) { updates.push("sync_goodreads_status_enabled = ?"); vals.push(ss.syncGoodreadsStatusEnabled ? 1 : 0); }
    if (ss.syncGoodreadsShelvesEnabled !== undefined) { updates.push("sync_goodreads_shelves_enabled = ?"); vals.push(ss.syncGoodreadsShelvesEnabled ? 1 : 0); }
    if (ss.syncWriteTagEnabled !== undefined) { updates.push("sync_write_tag_enabled = ?"); vals.push(ss.syncWriteTagEnabled ? 1 : 0); }
    if (ss.conflictStrategy !== undefined) { updates.push("conflict_strategy = ?"); vals.push(ss.conflictStrategy); }
    if (ss.scheduleEnabled !== undefined) { updates.push("schedule_enabled = ?"); vals.push(ss.scheduleEnabled ? 1 : 0); }
    if (ss.scheduleCron !== undefined) { updates.push("schedule_cron = ?"); vals.push(ss.scheduleCron); }
    if (updates.length) {
      vals.push(id);
      db.prepare(`UPDATE sync_settings SET ${updates.join(", ")} WHERE profile_id = ?`).run(...vals);
    }
  }

  res.json({ ok: true });
});

// DELETE /api/profiles/:id
router.delete("/:id", (req, res) => {
  const id = parseProfileId(req.params["id"]);
  if (id === null) {
    res.status(400).json({ error: "Invalid profile id" });
    return;
  }
  const result = getDb().prepare("DELETE FROM profiles WHERE id = ?").run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  res.json({ ok: true });
});

// GET /api/profiles/:id/hardcover/lists — proxy to Hardcover API
router.get("/:id/hardcover/lists", async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params["id"] ?? "0", 10);
  const hc = db.prepare("SELECT api_token FROM hardcover_connections WHERE profile_id = ?").get(id) as { api_token: string } | undefined;
  if (!hc?.api_token) { res.status(400).json({ error: "Hardcover not configured" }); return; }
  try {
    const lists = await fetchHardcoverLists(hc.api_token);
    res.json({ lists: lists.map(({ id: lid, name, slug }) => ({ id: lid, name, slug })) });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/profiles/:id/goodreads/shelves — scrape user's custom shelf names from Goodreads
router.get("/:id/goodreads/shelves", async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params["id"] ?? "0", 10);
  const gr = db.prepare("SELECT goodreads_user_id FROM goodreads_connections WHERE profile_id = ?").get(id) as { goodreads_user_id: string } | undefined;
  if (!gr?.goodreads_user_id) { res.status(400).json({ error: "Goodreads not configured" }); return; }
  try {
    const shelves = await fetchGoodreadsCustomShelves(gr.goodreads_user_id);
    res.json({ shelves });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/profiles/:id/goodreads/shelf-mappings
router.get("/:id/goodreads/shelf-mappings", (req, res) => {
  const db = getDb();
  const id = parseInt(req.params["id"] ?? "0", 10);
  const rows = db.prepare(`
    SELECT id, source_list_name, grimmory_shelf_name, grimmory_shelf_id, enabled
    FROM shelf_mappings WHERE profile_id = ? AND source = 'goodreads' AND source_list_id IS NULL
    ORDER BY source_list_name
  `).all(id) as {
    id: number;
    source_list_name: string;
    grimmory_shelf_name: string;
    grimmory_shelf_id: number | null;
    enabled: number;
  }[];
  const mappings: GoodreadsShelfMapping[] = rows.map((r) => ({
    id: r.id,
    goodreadsShelfName: r.source_list_name,
    grimmoryShelfName: r.grimmory_shelf_name,
    grimmoryShelfId: r.grimmory_shelf_id,
    enabled: Boolean(r.enabled)
  }));
  res.json({ mappings });
});

// POST /api/profiles/:id/goodreads/shelf-mappings — full replace
router.post("/:id/goodreads/shelf-mappings", (req, res) => {
  const id = parseProfileId(req.params["id"]);
  if (id === null) {
    res.status(400).json({ error: "Invalid profile id" });
    return;
  }
  const parsed = goodreadsMappingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(validationErrorResponse(parsed.error));
    return;
  }
  const db = getDb();
  if (!profileExists(db, id)) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  replaceGoodreadsShelfMappings(db, id, parsed.data.mappings);
  res.json({ ok: true });
});

// GET /api/profiles/:id/grimmory/shelves — proxy to Grimmory API
router.get("/:id/grimmory/shelves", async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params["id"] ?? "0", 10);
  const gc = db.prepare("SELECT base_url, username, password FROM grimmory_connections WHERE profile_id = ?").get(id) as { base_url: string; username: string; password: string } | undefined;
  const baseUrl = gc?.base_url?.trim() || getSetting("grimmory.baseUrl", "");
  if (!baseUrl || !gc?.username || !gc?.password) { res.json({ shelves: [] }); return; }
  try {
    const token = await getGrimmoryToken(baseUrl, gc.username, gc.password);
    if (!token) { res.json({ shelves: [] }); return; }
    const shelves = await fetchGrimmoryShelfList(baseUrl, token);
    res.json({ shelves });
  } catch {
    res.json({ shelves: [] });
  }
});

// GET /api/profiles/:id/list-mappings
router.get("/:id/list-mappings", (req, res) => {
  const db = getDb();
  const id = parseInt(req.params["id"] ?? "0", 10);
  const rows = db.prepare(`
    SELECT id, source_list_id, source_list_name, grimmory_shelf_name, grimmory_shelf_id, enabled
    FROM shelf_mappings WHERE profile_id = ? AND source = 'hardcover' AND source_list_id IS NOT NULL
    ORDER BY source_list_name
  `).all(id) as {
    id: number;
    source_list_id: string;
    source_list_name: string;
    grimmory_shelf_name: string;
    grimmory_shelf_id: number | null;
    enabled: number;
  }[];
  const mappings: HardcoverListMapping[] = rows.map((r) => ({
    id: r.id,
    hardcoverListId: parseInt(r.source_list_id, 10),
    hardcoverListName: r.source_list_name,
    grimmoryShelfName: r.grimmory_shelf_name,
    grimmoryShelfId: r.grimmory_shelf_id,
    enabled: Boolean(r.enabled)
  }));
  res.json({ mappings });
});

// POST /api/profiles/:id/list-mappings — full replace
router.post("/:id/list-mappings", (req, res) => {
  const id = parseProfileId(req.params["id"]);
  if (id === null) {
    res.status(400).json({ error: "Invalid profile id" });
    return;
  }
  const parsed = hardcoverMappingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(validationErrorResponse(parsed.error));
    return;
  }
  const db = getDb();
  if (!profileExists(db, id)) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  replaceHardcoverListMappings(db, id, parsed.data.mappings);
  res.json({ ok: true });
});

// POST /api/profiles/:id/test/grimmory
// Accepts optional { username, password, baseUrl } in body — uses those directly
// so the UI can test unsaved form values without a save-first round trip.
router.post("/:id/test/grimmory", async (req, res) => {
  const id = parseProfileId(req.params["id"]);
  if (id === null) { res.status(400).json({ error: "Invalid profile id" }); return; }
  const parsed = profileGrimmoryTestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json(validationErrorResponse(parsed.error)); return; }
  const body = parsed.data;
  const db = getDb();
  if (!profileExists(db, id)) { res.status(404).json({ error: "Profile not found" }); return; }

  const stored = db.prepare("SELECT * FROM grimmory_connections WHERE profile_id = ?").get(id) as DbGrimmory | undefined;

  const baseUrl = body.baseUrl?.trim() || stored?.base_url || getSetting("grimmory.baseUrl", "");
  const username = body.username?.trim() || stored?.username || "";
  const password = body.password || stored?.password || "";

  if (!baseUrl || !username || !password) {
    res.json({ ok: false, message: "Grimmory URL, username and password are all required" });
    return;
  }

  const result = await testGrimmoryLogin(baseUrl, username, password);

  if (stored) {
    const now = new Date().toISOString();
    db.prepare("UPDATE grimmory_connections SET status = ?, last_tested_at = ?, last_success_at = ? WHERE profile_id = ?")
      .run(result.ok ? "connected" : "failed", now, result.ok ? now : stored.last_success_at, id);
  }

  res.json(result);
});

// POST /api/profiles/:id/test/hardcover
// Accepts optional { apiToken } in body.
router.post("/:id/test/hardcover", async (req, res) => {
  const id = parseProfileId(req.params["id"]);
  if (id === null) { res.status(400).json({ error: "Invalid profile id" }); return; }
  const parsed = profileHardcoverTestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json(validationErrorResponse(parsed.error)); return; }
  const body = parsed.data;
  const db = getDb();
  if (!profileExists(db, id)) { res.status(404).json({ error: "Profile not found" }); return; }

  const stored = db.prepare("SELECT * FROM hardcover_connections WHERE profile_id = ?").get(id) as DbHardcover | undefined;
  const token = body.apiToken ?? stored?.api_token ?? "";

  if (!token.trim()) {
    res.json({ ok: false, message: "No API token provided" });
    return;
  }

  const result = await testHardcoverToken(token);

  if (stored) {
    const now = new Date().toISOString();
    const username = result.ok ? result.username ?? null : stored.hardcover_username;
    db.prepare("UPDATE hardcover_connections SET status = ?, last_tested_at = ?, last_success_at = ?, hardcover_username = ? WHERE profile_id = ?")
      .run(result.ok ? "connected" : "failed", now, result.ok ? now : stored.last_success_at, username, id);
  }

  res.json(result);
});

// POST /api/profiles/:id/test/goodreads
// Accepts optional { goodreadsUserId } in body.
router.post("/:id/test/goodreads", async (req, res) => {
  const id = parseProfileId(req.params["id"]);
  if (id === null) { res.status(400).json({ error: "Invalid profile id" }); return; }
  const parsed = profileGoodreadsTestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json(validationErrorResponse(parsed.error)); return; }
  const body = parsed.data;
  const db = getDb();
  if (!profileExists(db, id)) { res.status(404).json({ error: "Profile not found" }); return; }

  const stored = db.prepare("SELECT * FROM goodreads_connections WHERE profile_id = ?").get(id) as DbGoodreads | undefined;
  const userId = body.goodreadsUserId ?? stored?.goodreads_user_id ?? "";

  if (!userId.trim()) {
    res.json({ ok: false, message: "No Goodreads user ID provided" });
    return;
  }

  const result = await testGoodreadsUser(userId);

  if (stored) {
    const now = new Date().toISOString();
    const username = result.ok ? result.username ?? null : stored.goodreads_username;
    db.prepare("UPDATE goodreads_connections SET status = ?, last_tested_at = ?, last_success_at = ?, goodreads_username = ? WHERE profile_id = ?")
      .run(result.ok ? "connected" : "failed", now, result.ok ? now : stored.last_success_at, username, id);
  }

  res.json(result);
});

// POST /api/profiles/:id/test/audiobookshelf
// Accepts optional { apiKey } in body.
router.post("/:id/test/audiobookshelf", async (req, res) => {
  const id = parseProfileId(req.params["id"]);
  if (id === null) { res.status(400).json({ error: "Invalid profile id" }); return; }
  const parsed = profileAudiobookshelfTestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json(validationErrorResponse(parsed.error)); return; }
  const body = parsed.data;
  const db = getDb();
  if (!profileExists(db, id)) { res.status(404).json({ error: "Profile not found" }); return; }

  const stored = db.prepare("SELECT * FROM audiobookshelf_connections WHERE profile_id = ?").get(id) as DbAudiobookshelf | undefined;
  const apiKey = body.apiKey ?? stored?.api_key ?? "";
  const baseUrl = (getSetting("audiobookshelf.baseUrl", "")).trim();

  if (!apiKey.trim()) {
    res.json({ ok: false, message: "No API key provided" });
    return;
  }
  if (!baseUrl) {
    res.json({ ok: false, message: "Audiobookshelf base URL is not configured in Settings" });
    return;
  }

  const result = await testAudiobookshelfToken(baseUrl, apiKey);

  if (stored) {
    const now = new Date().toISOString();
    const username = result.ok ? result.username ?? null : stored.abs_username;
    db.prepare(`
      UPDATE audiobookshelf_connections
      SET status = ?, last_tested_at = ?, last_success_at = ?, abs_username = ?
      WHERE profile_id = ?
    `).run(result.ok ? "connected" : "failed", now, result.ok ? now : stored.last_success_at, username, id);
  }

  res.json(result);
});

// ─── Internal DB row types ─────────────────────────────────────────────────────

interface DbProfile {
  id: number;
  display_name: string;
  enabled: number;
  created_at: string;
}

interface DbGrimmory {
  id: number;
  profile_id: number;
  base_url: string;
  username: string;
  password: string;
  refresh_token: string | null;
  grimmory_user_id: string | null;
  status: string;
  last_tested_at: string | null;
  last_success_at: string | null;
}

interface DbHardcover {
  id: number;
  profile_id: number;
  api_token: string;
  hardcover_user_id: string | null;
  hardcover_username: string | null;
  status: string;
  last_tested_at: string | null;
  last_success_at: string | null;
  sync_list_id: string | null;
  sync_list_name: string | null;
  target_shelf_name: string | null;
}

interface DbGoodreads {
  id: number;
  profile_id: number;
  goodreads_user_id: string;
  goodreads_username: string | null;
  enabled: number;
  status: string;
  last_tested_at: string | null;
  last_success_at: string | null;
  sync_shelf_name: string | null;
  target_shelf_name: string | null;
}

interface DbAudiobookshelf {
  id: number;
  profile_id: number;
  api_key: string;
  abs_user_id: string | null;
  abs_username: string | null;
  status: string;
  last_tested_at: string | null;
  last_success_at: string | null;
}

interface DbSyncSettings {
  id: number;
  profile_id: number;
  sync_status_enabled: number;
  sync_progress_enabled: number;
  sync_shelves_enabled: number;
  sync_goodreads_enabled: number;
  sync_goodreads_status_enabled: number;
  sync_goodreads_shelves_enabled: number;
  sync_write_tag_enabled: number;
  conflict_strategy: string;
  schedule_enabled: number;
  schedule_cron: string | null;
  dry_run_default: number;
}

export default router;
