import assert from "node:assert/strict";
import dns from "node:dns/promises";
import test from "node:test";
import { fetchCoverImage, fetchIntegration, isPrivateAddress, lookupPublicAddress, setCoverFetchForTesting, UnsafeIntegrationUrlError, validateCoverUrl, validateIntegrationUrl, validateOutboundUrl } from "../../src/server/security/outbound.js";

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
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    // RFC 5737 documentation ranges (TEST-NET-1/2/3) are IANA special-purpose,
    // not-globally-reachable addresses — not real public destinations.
    "192.0.2.5", "198.51.100.5", "203.0.113.5"
  ]) {
    assert.equal(isPrivateAddress(address), true, `${address} should be private`);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255"]) {
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

test("isPrivateAddress classifies alternate IPv6 compressions of a mapped address", () => {
  assert.equal(isPrivateAddress("0:0:0::ffff:7f00:1"), true);
  assert.equal(isPrivateAddress("::ffff:7f00:1"), true);
  assert.equal(isPrivateAddress("0:0:0:0:0:ffff:7f00:1"), true);
});

test("isPrivateAddress classifies IPv4-compatible IPv6 addresses (::/96)", () => {
  assert.equal(isPrivateAddress("::10.0.0.1"), true);
  assert.equal(isPrivateAddress("::000a:0001"), true);
  assert.equal(isPrivateAddress("::8.8.8.8"), false);
  assert.equal(isPrivateAddress("::0808:0808"), false);
});

test("isPrivateAddress classifies NAT64 addresses (64:ff9b::/96)", () => {
  assert.equal(isPrivateAddress("64:ff9b::10.0.0.1"), true);
  assert.equal(isPrivateAddress("64:ff9b::0a00:0001"), true);
  assert.equal(isPrivateAddress("64:ff9b::8.8.8.8"), false);
  assert.equal(isPrivateAddress("64:ff9b::0808:0808"), false);
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

test("cover connector lookup accepts a hostname that resolves only to public addresses", async () => {
  const originalLookup = dns.lookup;
  (dns as unknown as { lookup: typeof dns.lookup }).lookup = (async () => [{ address: "8.8.8.8", family: 4 }]) as typeof dns.lookup;

  try {
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookupPublicAddress("covers.example.test", {}, (error, address, family) => {
        if (error || typeof address !== "string" || family === undefined) reject(error ?? new Error("Expected one address"));
        else resolve({ address, family });
      });
    });
    assert.deepEqual(result, { address: "8.8.8.8", family: 4 });
  } finally {
    (dns as unknown as { lookup: typeof dns.lookup }).lookup = originalLookup;
  }
});

test("cover image redirects retain the secure dispatcher and validate each destination", async () => {
  const originalLookup = dns.lookup;
  const requested: Array<{ url: string; redirect: unknown; dispatcher: unknown }> = [];
  (dns as unknown as { lookup: typeof dns.lookup }).lookup = (async () => [{ address: "8.8.8.8", family: 4 }]) as typeof dns.lookup;
  const restoreCoverFetch = setCoverFetchForTesting((async (url, init) => {
    requested.push({
      url: String(url),
      redirect: init?.redirect,
      dispatcher: (init as { dispatcher?: unknown } | undefined)?.dispatcher
    });
    if (String(url) === "https://covers.example.test/book.jpg") {
      return new Response(null, { status: 302, headers: { location: "https://cdn.example.test/book.jpg" } });
    }
    return new Response(null, { status: 204 });
  }) as never);

  try {
    const res = await fetchCoverImage("https://covers.example.test/book.jpg");
    assert.equal(res.status, 204);
  } finally {
    (dns as unknown as { lookup: typeof dns.lookup }).lookup = originalLookup;
    restoreCoverFetch();
  }

  assert.deepEqual(requested.map((request) => request.url), [
    "https://covers.example.test/book.jpg",
    "https://cdn.example.test/book.jpg"
  ]);
  assert.ok(requested.every((request) => request.redirect === "manual" && request.dispatcher !== undefined));
});

test("cover image requests reject a DNS rebind before the connector can reach a private address", async () => {
  const originalLookup = dns.lookup;
  let lookupCount = 0;
  (dns as unknown as { lookup: typeof dns.lookup }).lookup = (async () => {
    lookupCount++;
    return [{ address: lookupCount === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }];
  }) as typeof dns.lookup;

  try {
    await assert.rejects(
      fetchCoverImage("http://rebind.example.test/cover.jpg"),
      UnsafeIntegrationUrlError
    );
  } finally {
    (dns as unknown as { lookup: typeof dns.lookup }).lookup = originalLookup;
  }

  assert.equal(lookupCount, 2, "the connector must resolve independently and reject the rebinding result");
});

test("cover connector lookup returns address candidates when Node requests all addresses", async () => {
  const originalLookup = dns.lookup;
  (dns as unknown as { lookup: typeof dns.lookup }).lookup = (async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "2001:4860:4860::8888", family: 6 }
  ]) as typeof dns.lookup;

  try {
    const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      lookupPublicAddress("covers.example.test", { all: true }, (error, result) => {
        if (error) reject(error);
        else resolve(result as Array<{ address: string; family: number }>);
      });
    });
    assert.deepEqual(addresses, [
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 }
    ]);
  } finally {
    (dns as unknown as { lookup: typeof dns.lookup }).lookup = originalLookup;
  }
});
