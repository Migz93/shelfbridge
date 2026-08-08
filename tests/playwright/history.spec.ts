import { test, expect } from "@playwright/test";

/**
 * Sync History tests — verify the status filter buttons and page-size
 * selector render, and that filtering updates the URL.
 * Read-only. Safe to run against a live instance.
 */

test.describe("Sync History filters", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/history");
    await expect(page.getByRole("heading", { name: "Sync History" })).toBeVisible();
    await expect(page.getByText("Loading history...")).not.toBeVisible({ timeout: 10_000 });
  });

  test("Status filter buttons are all visible", async ({ page }) => {
    await expect(page.getByRole("button", { name: /^all$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^running$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^success$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^error$/i })).toBeVisible();
  });

  test("Page size select is visible", async ({ page }) => {
    await expect(page.locator("select")).toBeVisible();
  });

  test("Success status filter updates the URL", async ({ page }) => {
    await page.getByRole("button", { name: /^success$/i }).click();
    await expect(page).toHaveURL(/[?&]status=success/);
  });

  test("All status filter resets the status param to all", async ({ page }) => {
    await page.getByRole("button", { name: /^success$/i }).click();
    await expect(page).toHaveURL(/[?&]status=success/);
    await page.getByRole("button", { name: /^all$/i }).click();
    await expect(page).toHaveURL(/[?&]status=all/);
  });
});
