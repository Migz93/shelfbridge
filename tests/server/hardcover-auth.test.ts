import assert from "node:assert/strict";
import test from "node:test";
import { hardcoverQuery, testHardcoverToken } from "../../src/server/sync/hardcover.js";

test("Hardcover PATs use Bearer authorization while legacy headers are preserved", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const authorizations: string[] = [];
  let responseBody = JSON.stringify({ data: { me: [{ id: 1, username: "reader" }] } });

  globalThis.fetch = async (_url, init) => {
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response(responseBody, { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    await hardcoverQuery("  hc_pat_secret-value  ", "query { me { id } }");
    await hardcoverQuery("Bearer legacy-jwt", "query { me { id } }");
    assert.deepEqual(authorizations, ["Bearer hc_pat_secret-value", "Bearer legacy-jwt"]);

    responseBody = JSON.stringify({ errors: [{ message: "Missing required scope: read:me for hc_pat_secret-value" }] });
    const result = await testHardcoverToken("hc_pat_secret-value");
    assert.deepEqual(result, { ok: false, message: "Missing required scope: read:me for [redacted]" });
    assert.equal(result.message.includes("hc_pat_secret-value"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
