import assert from "node:assert/strict";
import test from "node:test";
import {
  goodreadsMappingsSchema,
  hardcoverMappingsSchema,
  integrationTestSchema,
  jobIntervalSchema,
  profileCreateSchema,
  profileGrimmoryTestSchema,
  profilePatchSchema,
  settingsPatchSchema,
  syncRunSchema,
  writeGrimmoryIdSchema
} from "../../src/server/validation.js";
import { replaceHardcoverListMappings } from "../../src/server/routes/profiles.js";
import { parsePositiveId } from "../../src/server/routes/books.js";
import { createTestDatabase } from "./test-db.js";
import { seedProfile } from "./test-helpers.js";

test("settings patches reject malformed values and unsupported conflict strategies", () => {
  assert.equal(settingsPatchSchema.safeParse({ chaptarr: { addMenuLink: "true" } }).success, false);
  assert.equal(settingsPatchSchema.safeParse({ sync: { historyRetentionDays: -1 } }).success, false);
  assert.equal(settingsPatchSchema.safeParse({ sync: { conflictStrategy: "last_write_wins" } }).success, false);
  assert.equal(settingsPatchSchema.safeParse({ unexpected: true }).success, false);
  assert.equal(settingsPatchSchema.safeParse({ sync: { historyRetentionDays: 7 } }).success, true);
});

test("manual sync requires a positive integer profile id", () => {
  assert.equal(syncRunSchema.safeParse({ profileId: 0 }).success, false);
  assert.equal(syncRunSchema.safeParse({ profileId: 1.5 }).success, false);
  assert.equal(syncRunSchema.safeParse({ profileId: "1" }).success, false);
  assert.equal(syncRunSchema.safeParse({ profileId: 1, dryRun: true }).success, true);
});

test("profile requests reject malformed connections and sync settings", () => {
  assert.equal(profileCreateSchema.safeParse({ displayName: "  " }).success, false);
  assert.equal(profilePatchSchema.safeParse({ enabled: "true" }).success, false);
  assert.equal(profilePatchSchema.safeParse({ syncSettings: { conflictStrategy: "last_write_wins" } }).success, false);
  assert.equal(profilePatchSchema.safeParse({ hardcover: { syncListId: 0 } }).success, false);
  assert.equal(profilePatchSchema.safeParse({ goodreads: { enabled: true } }).success, true);
});

test("connection tests, jobs, and book actions reject malformed request bodies", () => {
  assert.equal(integrationTestSchema.safeParse({ baseUrl: 42 }).success, false);
  assert.equal(integrationTestSchema.safeParse({ baseUrl: " " }).success, false);
  assert.equal(integrationTestSchema.safeParse({ baseUrl: "ftp://integration.example.test" }).success, false);
  assert.equal(integrationTestSchema.safeParse({ baseUrl: "https://user:pass@integration.example.test" }).success, false);
  assert.equal(profileGrimmoryTestSchema.safeParse({ username: true }).success, false);
  assert.equal(profileGrimmoryTestSchema.safeParse({ baseUrl: "" }).success, false);
  assert.equal(jobIntervalSchema.safeParse({ intervalMinutes: 1.5 }).success, false);
  assert.equal(writeGrimmoryIdSchema.safeParse({ source: "audiobookshelf" }).success, false);
  assert.equal(writeGrimmoryIdSchema.safeParse({ source: "goodreads" }).success, true);
});

test("book mutation IDs must be complete positive integers", () => {
  assert.equal(parsePositiveId("12"), 12);
  assert.equal(parsePositiveId("12oops"), null);
  assert.equal(parsePositiveId("1.5"), null);
  assert.equal(parsePositiveId("0"), null);
});

test("mapping replacements reject malformed rows before changing stored mappings", () => {
  assert.equal(goodreadsMappingsSchema.safeParse({ mappings: [{ goodreadsShelfName: "", grimmoryShelfName: "Reading" }] }).success, false);
  assert.equal(hardcoverMappingsSchema.safeParse({ mappings: [{ hardcoverListId: 0, hardcoverListName: "Favourites", grimmoryShelfName: "Reading" }] }).success, false);
});

test("a failed list-mapping replacement retains the previous mappings", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    db.prepare(`
      INSERT INTO shelf_mappings (profile_id, source, source_status, source_list_id, source_list_name, grimmory_shelf_name)
      VALUES (?, 'hardcover', 'Old list', '99', 'Old list', 'Old shelf')
    `).run(profileId);
    db.exec(`
      CREATE TRIGGER fail_second_mapping
      BEFORE INSERT ON shelf_mappings
      WHEN NEW.source = 'hardcover' AND NEW.source_list_id = '2'
      BEGIN
        SELECT RAISE(ABORT, 'forced mapping failure');
      END;
    `);

    assert.throws(() => replaceHardcoverListMappings(db, profileId, [
      { hardcoverListId: 1, hardcoverListName: "First", grimmoryShelfName: "First shelf" },
      { hardcoverListId: 2, hardcoverListName: "Second", grimmoryShelfName: "Second shelf" }
    ]), /forced mapping failure/);

    const mappings = db.prepare(`
      SELECT source_list_id, source_list_name, grimmory_shelf_name
      FROM shelf_mappings
      WHERE profile_id = ? AND source = 'hardcover'
    `).all(profileId) as Array<{ source_list_id: string; source_list_name: string; grimmory_shelf_name: string }>;
    assert.deepEqual(mappings, [{ source_list_id: "99", source_list_name: "Old list", grimmory_shelf_name: "Old shelf" }]);
  } finally {
    cleanup();
  }
});
