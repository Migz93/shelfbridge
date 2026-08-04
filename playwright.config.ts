import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

config({ path: ".env.playwright" });

const baseURL = process.env.BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/playwright",
  outputDir: "./tests/test-results",
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "tests/playwright-report", open: "never" }]
  ],

  use: {
    baseURL,
    trace: "on-first-retry"
  },

  projects: [
    // Auth setup — skipped automatically once storageState.json exists
    {
      name: "auth-setup",
      testMatch: /auth\.setup\.ts/
    },
    // All other tests load the saved session and depend on auth being done
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/playwright/.auth/storageState.json"
      },
      dependencies: ["auth-setup"]
    }
  ]
});
