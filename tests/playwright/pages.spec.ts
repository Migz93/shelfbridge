import { test, expect } from "@playwright/test";

/**
 * Smoke tests — verify each main page loads without errors.
 * These are read-only and safe to run against a live instance.
 */

test.describe("Page smoke tests", () => {
  test("Dashboard loads", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("Books loads", async ({ page }) => {
    await page.goto("/books");
    await expect(page.getByRole("heading", { name: "Books", exact: true })).toBeVisible();
  });

  test("Audiobooks loads", async ({ page }) => {
    await page.goto("/audiobooks");
    await expect(page.getByRole("heading", { name: "Audiobooks", exact: true })).toBeVisible();
  });

  test("Users loads", async ({ page }) => {
    await page.goto("/users");
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
  });

  test("Sync History loads", async ({ page }) => {
    await page.goto("/history");
    await expect(page.getByRole("heading", { name: "Sync History" })).toBeVisible();
  });

  test("Settings loads", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  });

  test("Sidebar navigation links are present", async ({ page }) => {
    await page.goto("/dashboard");
    // Scope to the <nav> element to avoid matching same-named links in the page body
    const nav = page.locator("nav");
    await expect(nav.getByRole("link", { name: /dashboard/i })).toBeVisible();
    await expect(nav.getByRole("link", { name: /books/i }).first()).toBeVisible();
    await expect(nav.getByRole("link", { name: /users/i })).toBeVisible();
    await expect(nav.getByRole("link", { name: /history/i })).toBeVisible();
    await expect(nav.getByRole("link", { name: /settings/i })).toBeVisible();
  });

  test("Sidebar navigation works", async ({ page }) => {
    await page.goto("/dashboard");
    const nav = page.locator("nav");

    await nav.getByRole("link", { name: /^books$/i }).click();
    await expect(page).toHaveURL(/\/books/);
    await expect(page.getByRole("heading", { name: "Books", exact: true })).toBeVisible();

    await nav.getByRole("link", { name: /users/i }).click();
    await expect(page).toHaveURL(/\/users/);

    await nav.getByRole("link", { name: /history/i }).click();
    await expect(page).toHaveURL(/\/history/);

    await nav.getByRole("link", { name: /settings/i }).click();
    await expect(page).toHaveURL(/\/settings/);
  });

  test("Unauthenticated request redirects to login", async ({ browser }) => {
    // Fresh context with no session cookies
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    await context.close();
  });
});
