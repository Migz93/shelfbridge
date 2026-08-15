import assert from "node:assert/strict";
import test from "node:test";
import { fetchIntegration, UnsafeIntegrationUrlError, validateIntegrationUrl, validateOutboundUrl } from "../../src/server/security/outbound.js";

test("integration URLs allow normal LAN HTTP endpoints", () => {
  assert.equal(validateIntegrationUrl("http://192.168.1.20:9303/api/"), "http://192.168.1.20:9303/api");
  assert.equal(validateIntegrationUrl("https://books.example.test"), "https://books.example.test");
});

test("integration URLs reject invalid schemes, credentials, and non-strings", () => {
  for (const value of ["ftp://example.test", "https://user:pass@example.test", "/api/v1", null, 42]) {
    assert.throws(() => validateIntegrationUrl(value), UnsafeIntegrationUrlError);
  }
});

test("outbound integration requests reject an empty URL", () => {
  assert.throws(
    () => validateOutboundUrl(""),
    (error: unknown) => error instanceof UnsafeIntegrationUrlError && error.message === "Integration URL must not be empty"
  );
});

test("integration requests disable automatic redirects", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return new Response(null, { status: 204 });
  };

  try {
    await fetchIntegration("http://192.168.1.20:9303/api/status", {
      headers: { Authorization: "Bearer test-token" },
      redirect: "follow"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestUrl, "http://192.168.1.20:9303/api/status");
  assert.equal(requestInit?.redirect, "error");
});
