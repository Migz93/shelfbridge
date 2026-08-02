import fs from "node:fs";
import path from "node:path";

type BuildChannel = "stable" | "develop" | "custom";

const VALID_BUILD_CHANNELS: readonly BuildChannel[] = ["stable", "develop", "custom"];

function readPackageVersion(): string {
  const packagePath = path.resolve(process.cwd(), "package.json");
  const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || !parsed.version.trim()) {
    throw new Error(`package.json at ${packagePath} has no version`);
  }
  return parsed.version;
}

function normalizeBuildChannel(value: string | undefined): BuildChannel {
  const normalized = value?.trim();
  return VALID_BUILD_CHANNELS.includes(normalized as BuildChannel) ? normalized as BuildChannel : "custom";
}

export const APP_VERSION = readPackageVersion();
export const BUILD_CHANNEL = normalizeBuildChannel(process.env["BUILD_CHANNEL"]);
export const BUILD_COMMIT = process.env["COMMIT_SHA"]?.trim() || "local";
