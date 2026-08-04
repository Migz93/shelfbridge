import { test, expect } from "@playwright/test";

/**
 * Books / Audiobooks catalog tests — verify the status filter chips render and
 * update the URL. Chips carry an optional count (e.g. "Reading 3"), so names
 * are matched with a count-tolerant pattern, scoped to the Status row to avoid
 * colliding with same-named chips in the profile/source rows.
 * Read-only. Safe to run against a live instance.
 */

const chip = (label: string) => new RegExp(`^${label}( \\d+)?$`);

function statusRow(page: import("@playwright/test").Page) {
  return page
    .locator("div")
    .filter({ has: page.getByText("Status", { exact: true }) })
    .last();
}

test.describe("Books filters", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/books");
    await expect(page.getByRole("heading", { name: "Books", exact: true })).toBeVisible();
  });

  test("Status filter chips are all visible", async ({ page }) => {
    const row = statusRow(page);
    await expect(row.getByRole("button", { name: chip("All") })).toBeVisible();
    await expect(row.getByRole("button", { name: chip("To Read") })).toBeVisible();
    await expect(row.getByRole("button", { name: chip("Reading") })).toBeVisible();
    await expect(row.getByRole("button", { name: chip("Read") })).toBeVisible();
    await expect(row.getByRole("button", { name: chip("DNF") })).toBeVisible();
  });

  test("Reading status filter updates the URL", async ({ page }) => {
    const reading = statusRow(page).getByRole("button", { name: chip("Reading") });
    await expect(reading).toBeVisible();
    // Retry the click briefly — on a cold load the chip can render a moment
    // before its click handler is attached.
    await expect(async () => {
      await reading.click();
      await expect(page).toHaveURL(/[?&]status=READING/, { timeout: 1000 });
    }).toPass({ timeout: 10_000 });
  });

  test("All status filter clears the status param", async ({ page }) => {
    const row = statusRow(page);
    await row.getByRole("button", { name: chip("Reading") }).click();
    await expect(page).toHaveURL(/[?&]status=READING/);
    await row.getByRole("button", { name: chip("All") }).click();
    await expect(page).not.toHaveURL(/[?&]status=/);
  });
});

test.describe("Audiobooks filters", () => {
  test("Audiobooks page shows its own status labels", async ({ page }) => {
    await page.goto("/audiobooks");
    await expect(page.getByRole("heading", { name: "Audiobooks", exact: true })).toBeVisible();
    const row = statusRow(page);
    await expect(row.getByRole("button", { name: chip("To Listen") })).toBeVisible();
    await expect(row.getByRole("button", { name: chip("Listening") })).toBeVisible();
    await expect(row.getByRole("button", { name: chip("Listened") })).toBeVisible();
    await expect(row.getByRole("button", { name: chip("DNF") })).toBeVisible();
  });
});
