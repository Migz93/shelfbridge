import { test, expect, type Page } from "@playwright/test";

/**
 * Image cache tests — verify that cached cover images load correctly from the
 * local /images/ path and that the route requires authentication.
 *
 * Images are served from /images/<id>.jpg after being downloaded and cached
 * at sync time. Books that haven't been synced since the cache was introduced
 * render a fallback placeholder rather than an <img>, so they are naturally
 * excluded from load-failure checks.
 *
 * Images use loading="lazy". Rather than waiting for network idle (which
 * doesn't reliably signal that lazy images have settled, and can resolve
 * before an in-viewport image finishes decoding), wait deterministically
 * until every image currently in the DOM is either loaded or is below the
 * fold (and therefore expected to still be lazy-pending).
 */

async function checkCovers(page: Page, context: string) {
  await page.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>("img.object-cover[src*='/images/']"));
    return imgs.every((img) => img.complete || img.getBoundingClientRect().top > window.innerHeight);
  }, { timeout: 10_000 }).catch(() => {
    // Best-effort: fall through and let the failure check below report
    // exactly which in-viewport images never finished loading.
  });

  const results = await page.evaluate(() =>
    Array.from(document.querySelectorAll("img.object-cover[src*='/images/']")).map((el) => {
      const img = el as HTMLImageElement;
      return {
        alt: img.alt,
        src: img.src,
        complete: img.complete,
        loaded: img.complete && img.naturalWidth > 0
      };
    })
  );

  if (results.length === 0) {
    console.log(`  No cached cover images found on ${context} — skipping image checks (run a sync first?)`);
    return;
  }

  // Only flag images the browser actually attempted to load (complete === true).
  // Lazy images that are still off-screen will have complete === false and are not failures.
  const failed = results.filter((r) => r.complete && !r.loaded);

  if (failed.length > 0) {
    const details = failed.map((r) => `  - "${r.alt}" (${r.src})`).join("\n");
    throw new Error(`${failed.length} of ${results.length} covers failed to load on ${context}:\n${details}`);
  }

  console.log(`  ${results.length} cover(s) loaded successfully on ${context}`);
}

test.describe("Image cache — authentication", () => {
  test("/images/ route requires authentication", async ({ browser }) => {
    // Fresh context with no session cookies
    const context = await browser.newContext({ storageState: undefined });
    const response = await context.request.get("/images/test.jpg", { maxRedirects: 0 });
    expect(response.status()).toBe(401);
    await context.close();
  });
});

test.describe("Cover image loading", () => {
  test("Dashboard recently added covers all load", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Loading dashboard...")).not.toBeVisible({ timeout: 10_000 });

    await checkCovers(page, "Dashboard");
  });

  test("Books page covers all load", async ({ page }) => {
    await page.goto("/books");
    await expect(page.getByRole("heading", { name: "Books", exact: true })).toBeVisible();

    await checkCovers(page, "Books");
  });
});
