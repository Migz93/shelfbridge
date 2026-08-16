import assert from "node:assert/strict";
import test from "node:test";
import { fetchCoverImage, fetchIntegration, UnsafeIntegrationUrlError, validateCoverUrl, validateIntegrationUrl, validateOutboundUrl } from "../../src/server/security/outbound.js";

test("integration URLs allow normal LAN HTTP endpoints", () => {
  assert.equal(validateIntegrationUrl("http://192.168.1.20:9303/api/"), "http://192.168.1.20:9303/api");
  assert.equal(validateIntegrationUrl("https://books.example.test"), "https://books.example.test");
});

test("integration URLs reject invalid schemes, credentials, and non-strings", () => {
  for (const value of ["ftp://example.test", "https://user:pass@example.test", "/api/v1", null, 42]) {
    assert.throws(() => validateIntegrationUrl(value), UnsafeIntegrationUrlError);
  }
});

test("integration URLs pass an empty string through unchanged", () => {
  assert.equal(validateIntegrationUrl(""), "");
  assert.equal(validateIntegrationUrl("   "), "");
});

test("outbound integration requests reject an empty URL", () => {
  assert.throws(
    () => validateOutboundUrl(""),
    (error: unknown) => error instanceof UnsafeIntegrationUrlError && error.message === "Integration URL must not be empty"
  );
});

test("cover URLs reject private/loopback/link-local hosts", () => {
  for (const value of ["http://127.0.0.1/cover.jpg", "http://localhost/cover.jpg", "http://192.168.1.5/cover.jpg", "http://10.0.0.5/cover.jpg", "http://169.254.1.1/cover.jpg", "http://[::1]/cover.jpg"]) {
    assert.throws(() => validateCoverUrl(value), UnsafeIntegrationUrlError);
  }
});

test("cover URLs allow ordinary public hosts", () => {
  assert.equal(validateCoverUrl("https://covers.example.test/book.jpg"), "https://covers.example.test/book.jpg");
});

test("integration requests follow a same-origin redirect", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    if (String(url) === "http://192.168.1.20:9303/api/status") {
      return new Response(null, { status: 302, headers: { location: "/api/status/" } });
    }
    return new Response(null, { status: 204 });
  };

  try {
    const res = await fetchIntegration("http://192.168.1.20:9303/api/status", { redirect: "follow" });
    assert.equal(res.status, 204);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requestedUrls, ["http://192.168.1.20:9303/api/status", "http://192.168.1.20:9303/api/status/"]);
});

test("integration requests reject a cross-origin redirect", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "https://evil.example.test/" } });

  try {
    await assert.rejects(
      fetchIntegration("http://192.168.1.20:9303/api/status"),
      UnsafeIntegrationUrlError
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cover image requests are rejected for private targets before any fetch happens", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response(null, { status: 204 }); };

  try {
    await assert.rejects(fetchCoverImage("http://127.0.0.1/cover.jpg"), UnsafeIntegrationUrlError);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(called, false);
});
