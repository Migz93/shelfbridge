import { test, expect } from "@playwright/test";

/**
 * Dashboard UI tests — verify stat chips, key sections, and action buttons.
 * Read-only. Safe to run against a live instance.
 */

test.describe("Dashboard UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Loading dashboard...")).not.toBeVisible({ timeout: 10_000 });
  });

  test("Stat chips are visible after load", async ({ page }) => {
    await expect(page.getByText("Books Tracked", { exact: true })).toBeVisible();
    await expect(page.getByText("Audiobooks Tracked")).toBeVisible();
    await expect(page.getByText("Not in Chaptarr").first()).toBeVisible();
    await expect(page.getByText("Grab in Chaptarr").first()).toBeVisible();
    await expect(page.getByText("Needs Review").first()).toBeVisible();
  });

  test("Books Tracked stat chip links to the books page", async ({ page }) => {
    await expect(page.locator('a[href="/books"]').first()).toBeVisible();
  });

  test("Audiobooks Tracked stat chip links to the audiobooks page", async ({ page }) => {
    await expect(page.locator('a[href="/audiobooks"]').first()).toBeVisible();
  });

  test("Not in Chaptarr stat chip links to the filtered books view", async ({ page }) => {
    await expect(page.locator('a[href="/books?action=add-to-chaptarr"]')).toBeVisible();
  });

  test("Recently Added section heading is visible", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Recently Added" })).toBeVisible();
  });

  test("Recent Syncs panel is visible and links to history", async ({ page }) => {
    // The entire Recent Syncs panel is an <a> linking to /history.
    await expect(page.getByRole("link", { name: /recent syncs/i })).toBeVisible();
  });

  test("Run Sync button is present", async ({ page }) => {
    await expect(page.getByRole("button", { name: /run sync/i })).toBeVisible();
  });
});
