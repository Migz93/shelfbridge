import { test, expect } from "@playwright/test";

/**
 * Settings page tests — verify the settings sections render with their
 * controls and save buttons. Read-only. Safe to run against a live instance.
 */

test.describe("Settings sections", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByText("Loading settings...")).not.toBeVisible({ timeout: 10_000 });
  });

  test("Network section shows the Trust Proxy control and its save button", async ({ page }) => {
    await expect(page.getByText("Network", { exact: true })).toBeVisible();
    await expect(page.getByText("Trust Proxy")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save Network" })).toBeVisible();
  });

  test("Sync Behaviour section shows Startup Sync and conflict strategy controls", async ({ page }) => {
    await expect(page.getByText("Sync Behaviour", { exact: true })).toBeVisible();
    await expect(page.getByText("Startup Sync")).toBeVisible();
    await expect(page.getByText("Default Conflict Strategy")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save Sync" })).toBeVisible();
  });

  test("History Retention section shows the retention period field", async ({ page }) => {
    await expect(page.getByText("History Retention", { exact: true })).toBeVisible();
    await expect(page.getByText("Retention Period (days)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save History" })).toBeVisible();
  });
});
