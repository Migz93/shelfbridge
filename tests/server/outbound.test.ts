import assert from "node:assert/strict";
import dns from "node:dns/promises";
import test from "node:test";
import { fetchCoverImage, fetchIntegration, isPrivateAddress, UnsafeIntegrationUrlError, validateCoverUrl, validateIntegrationUrl, validateOutboundUrl } from "../../src/server/security/outbound.js";

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

test("isPrivateAddress classifies IPv4 ranges", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, `${address} should be private`);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255", "203.0.113.5"]) {
    assert.equal(isPrivateAddress(address), false, `${address} should be public`);
  }
});

test("isPrivateAddress classifies IPv6 ranges, including IPv4-mapped addresses", () => {
  for (const address of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, `${address} should be private`);
  }
  for (const address of ["2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(address), false, `${address} should be public`);
  }
});

test("isPrivateAddress fails closed for a non-IP-literal input", () => {
  assert.equal(isPrivateAddress("not-an-ip"), true);
});

test("cover image requests reject a hostname that resolves to a private address via DNS, even though the hostname string itself isn't a private literal", async () => {
  const originalLookup = dns.lookup;
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  (dns as unknown as { lookup: typeof dns.lookup }).lookup = (async (hostname: string) => {
    assert.equal(hostname, "attacker-controlled.example.test");
    return [{ address: "127.0.0.1", family: 4 }];
  }) as typeof dns.lookup;
  globalThis.fetch = async () => { fetchCalled = true; return new Response(null, { status: 204 }); };

  try {
    await assert.rejects(
      fetchCoverImage("http://attacker-controlled.example.test/cover.jpg"),
      UnsafeIntegrationUrlError
    );
  } finally {
    (dns as unknown as { lookup: typeof dns.lookup }).lookup = originalLookup;
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalled, false, "the fetch must not happen once DNS resolves to a private address");
});

test("cover image requests proceed when DNS resolves a hostname to only public addresses", async () => {
  const originalLookup = dns.lookup;
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  (dns as unknown as { lookup: typeof dns.lookup }).lookup = (async () => [{ address: "203.0.113.5", family: 4 }]) as typeof dns.lookup;
  globalThis.fetch = async () => { fetchCalled = true; return new Response(null, { status: 204 }); };

  try {
    const res = await fetchCoverImage("http://covers.example.test/cover.jpg");
    assert.equal(res.status, 204);
  } finally {
    (dns as unknown as { lookup: typeof dns.lookup }).lookup = originalLookup;
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalled, true);
});
