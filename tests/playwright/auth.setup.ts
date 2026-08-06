import { test as setup } from "@playwright/test";
import fs from "fs";
import path from "path";

const authFile = "tests/playwright/.auth/storageState.json";
const baseURL = process.env.BASE_URL ?? "http://localhost:9303";

/**
 * Auth setup for Playwright tests.
 *
 * ShelfBridge uses a local password login. Grab your session cookie from the
 * browser you're already logged in with:
 *
 *   1. Open your ShelfBridge instance in Chrome/Firefox
 *   2. DevTools -> Application -> Cookies -> find "shelfbridge_session"
 *   3. Copy the cookie value
 *   4. Set it in .env.playwright:  SESSION_COOKIE=<paste here>
 *   5. Run:  npm run test:e2e
 *
 * The session will be saved to tests/playwright/.auth/storageState.json and
 * reused on every subsequent run. When it expires, repeat steps 2-5.
 */
/* eslint-disable playwright/no-conditional-in-test -- Auth setup branches around saved-session state and SESSION_COOKIE availability. */
setup("authenticate", async ({ request }) => {
  // If we already have a saved session, check it's still valid and bound to the current host
  if (fs.existsSync(authFile)) {
    const currentHost = new URL(baseURL).hostname;
    const savedDomain = getSavedCookieDomain();
    if (savedDomain && savedDomain !== currentHost) {
      console.log(`  Saved session is for '${savedDomain}' but BASE_URL is '${currentHost}' — re-authenticating.`);
    } else {
      const response = await request.get("/api/auth/session", {
        headers: { Cookie: buildCookieHeader() }
      });
      const session = await response.json() as { authenticated: boolean };
      if (session.authenticated) {
        console.log("  Existing session is still valid, skipping login.");
        return;
      }
      console.log("  Saved session has expired — re-run with a fresh SESSION_COOKIE.");
    }
  }

  const cookie = process.env.SESSION_COOKIE?.trim();
  if (!cookie) {
    throw new Error(
      "\n\n  SESSION_COOKIE is not set.\n" +
      "  Grab your shelfbridge_session cookie value from your browser's DevTools and\n" +
      "  add it to .env.playwright:\n\n" +
      "    SESSION_COOKIE=<your cookie value here>\n\n" +
      "  Then re-run the tests.\n"
    );
  }

  // Verify the provided cookie actually works before saving it
  const response = await request.get("/api/auth/session", {
    headers: { Cookie: `shelfbridge_session=${encodeURIComponent(cookie)}` }
  });
  const session = await response.json() as { authenticated: boolean };

  if (!session.authenticated) {
    throw new Error(
      "\n\n  The SESSION_COOKIE value did not authenticate successfully.\n" +
      "  Make sure you copied the full shelfbridge_session cookie value from DevTools.\n"
    );
  }

  console.log("  Session cookie authenticated successfully.");

  // Save storageState with this cookie so all tests can use it
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  const url = new URL(baseURL);
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      cookies: [
        {
          name: "shelfbridge_session",
          value: encodeURIComponent(cookie),
          domain: url.hostname,
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: url.protocol === "https:",
          sameSite: "Strict"
        }
      ],
      origins: []
    }, null, 2)
  );
  console.log("  Session saved to", authFile);
});
/* eslint-enable playwright/no-conditional-in-test */

function buildCookieHeader(): string {
  if (!fs.existsSync(authFile)) return "";
  const state = JSON.parse(fs.readFileSync(authFile, "utf-8")) as {
    cookies: Array<{ name: string; value: string }>
  };
  return state.cookies.map(c => `${c.name}=${c.value}`).join("; ");
}

function getSavedCookieDomain(): string | null {
  if (!fs.existsSync(authFile)) return null;
  const state = JSON.parse(fs.readFileSync(authFile, "utf-8")) as {
    cookies: Array<{ name: string; domain?: string }>
  };
  return state.cookies[0]?.domain ?? null;
}
