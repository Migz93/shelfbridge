import { test, expect } from "@playwright/test";

/**
 * API smoke tests — verify key endpoints return healthy responses.
 * Uses the request fixture (no browser), with the stored session cookie applied
 * automatically via storageState.
 * Read-only. Safe to run against a live instance.
 */

test.describe("API smoke tests", () => {
  test("GET /api/health returns 200", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);

    const body = await response.json() as Record<string, unknown>;
    expect(body).toHaveProperty("ok", true);
  });

  test("GET /api/auth/session returns authenticated session", async ({ request }) => {
    const response = await request.get("/api/auth/session");
    expect(response.status()).toBe(200);

    const body = await response.json() as { authenticated: boolean };
    expect(body.authenticated).toBe(true);
  });

  test("GET /api/dashboard returns expected shape", async ({ request }) => {
    const response = await request.get("/api/dashboard");
    expect(response.status()).toBe(200);

    const body = await response.json() as Record<string, unknown>;
    expect(body).toHaveProperty("stats");
    expect(body).toHaveProperty("recentlyAdded");
    expect(body).toHaveProperty("recentActivity");

    const stats = body.stats as Record<string, unknown>;
    expect(stats).toHaveProperty("totalBooks");
    expect(stats).toHaveProperty("missingInGrimmory");
    expect(stats).toHaveProperty("pendingDownload");
    expect(stats).toHaveProperty("needsReview");
  });
});
