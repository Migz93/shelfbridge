import { test, expect, type APIRequestContext } from "@playwright/test";

type JobInfo = {
  id: string;
  name: string;
  intervalDescription: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: "success" | "error" | null;
  isRunning: boolean;
};

/**
 * Live refresh test for the Maintenance job.
 *
 * This intentionally triggers real background work against a live instance,
 * then verifies the open Settings page updates without a browser reload.
 *
 * Maintenance is the only job safe to trigger this way: it only prunes
 * sync_runs rows already past the configured retention window and has no
 * external side effects. Sync writes real progress back to
 * Hardcover/Audiobookshelf/Grimmory and Image Cache Refresh makes real
 * outbound requests to those services, so neither belongs in an automated
 * suite that could run against a live personal library.
 */
test.describe("Live refresh — Jobs", () => {
  test.setTimeout(60_000);

  test("Maintenance job runs via Run Now and the Jobs table updates without reload", async ({ page, request }) => {
    const before = await getJob(request, "maintenance");

    await page.goto("/settings?tab=jobs");
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByText("Loading settings...")).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Loading jobs...")).not.toBeVisible({ timeout: 10_000 });

    const row = page.locator("tr", { hasText: "Maintenance" });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: /run now/i }).click();

    const completed = await waitForJobCompletion(request, "maintenance", before?.lastRunAt ?? null);

    await expect(row.getByRole("button", { name: "Run Now", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(completed.lastRunStatus ?? "success", { timeout: 30_000 });
  });
});

async function getJob(request: APIRequestContext, jobId: string): Promise<JobInfo | null> {
  const response = await request.get("/api/settings/jobs");
  expect(response.ok()).toBe(true);
  const jobs = await response.json() as JobInfo[];
  return jobs.find((job) => job.id === jobId) ?? null;
}

async function waitForJobCompletion(
  request: APIRequestContext,
  jobId: string,
  previousLastRunAt: string | null
): Promise<JobInfo> {
  await expect.poll(async () => {
    const job = await getJob(request, jobId);
    if (!job || job.isRunning) return null;
    if (job.lastRunAt === null || job.lastRunAt === previousLastRunAt) return null;
    return job.lastRunStatus;
  }, { timeout: 30_000 }).not.toBeNull();

  const job = await getJob(request, jobId);
  if (!job || job.lastRunAt === null || job.lastRunAt === previousLastRunAt) {
    throw new Error(`Expected job ${jobId} to record a new completion.`);
  }
  return job;
}
