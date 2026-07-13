import crypto from "crypto";
import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { logger } from "../logger.js";

const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
const KEY_FILE = path.join(DATA_DIR, "credential-key");
const PREFIX = "sbenc:v1";

let cachedKey: Buffer | null = null;

function parseConfiguredKey(value: string): Buffer {
  const trimmed = value.trim();
  const decoded = /^[a-f0-9]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");

  if (decoded.length === 32) return decoded;
  throw new Error("SHELFBRIDGE_CREDENTIAL_KEY must decode to 32 bytes");
}

function loadMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const configuredKey = process.env["SHELFBRIDGE_CREDENTIAL_KEY"];
  if (configuredKey?.trim()) {
    cachedKey = parseConfiguredKey(configuredKey);
    return cachedKey;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Create the key file exclusively so two processes racing to initialise it can't
  // clobber each other's key. If it already exists, read it instead of the one we generated.
  try {
    cachedKey = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, `${cachedKey.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    logger.info("Generated credential encryption key", { keyFile: KEY_FILE });
    return cachedKey;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    cachedKey = parseConfiguredKey(fs.readFileSync(KEY_FILE, "utf8"));
    return cachedKey;
  }
}

export function isEncryptedCredential(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${PREFIX}:`);
}

export function encryptCredential(value: string | null | undefined): string {
  if (!value) return "";
  if (isEncryptedCredential(value)) return value;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", loadMasterKey(), iv);
  cipher.setAAD(Buffer.from(PREFIX));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(":");
}

export function decryptCredential(value: string | null | undefined): string {
  if (!value) return "";
  if (!isEncryptedCredential(value)) return value;

  const parts = value.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== PREFIX) {
    throw new Error("Stored credential has an invalid encryption envelope");
  }

  const iv = Buffer.from(parts[2] ?? "", "base64url");
  const tag = Buffer.from(parts[3] ?? "", "base64url");
  const ciphertext = Buffer.from(parts[4] ?? "", "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", loadMasterKey(), iv);
  decipher.setAAD(Buffer.from(PREFIX));
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function migrateCredentialStorage(db: Database.Database): void {
  const migrateStringColumn = (table: string, idColumn: string, column: string) => {
    const rows = db.prepare(`SELECT ${idColumn} AS id, ${column} AS value FROM ${table}`).all() as {
      id: number;
      value: string | null;
    }[];
    const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${idColumn} = ?`);
    let migrated = 0;

    for (const row of rows) {
      if (!row.value || isEncryptedCredential(row.value)) continue;
      update.run(encryptCredential(row.value), row.id);
      migrated++;
    }

    if (migrated > 0) {
      logger.info("Migrated credentials to encrypted storage", { table, column, migrated });
    }
  };

  const migrateSetting = (key: string) => {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string | null } | undefined;
    if (!row?.value || isEncryptedCredential(row.value)) return;
    db.prepare("UPDATE app_settings SET value = ? WHERE key = ?").run(encryptCredential(row.value), key);
    logger.info("Migrated credential setting to encrypted storage", { key });
  };

  migrateStringColumn("grimmory_connections", "id", "encrypted_password");
  migrateStringColumn("grimmory_connections", "id", "encrypted_refresh_token");
  migrateStringColumn("hardcover_connections", "id", "encrypted_api_token");
  migrateStringColumn("audiobookshelf_connections", "id", "encrypted_api_key");
  migrateSetting("chaptarr.apiKey");
}
