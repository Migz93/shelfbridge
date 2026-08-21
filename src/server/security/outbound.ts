import dns from "node:dns/promises";
import net from "node:net";

export class UnsafeIntegrationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeIntegrationUrlError";
  }
}

export function validateIntegrationUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new UnsafeIntegrationUrlError("Integration URL must be a valid absolute URL");
  }
  const input = value.trim();
  if (!input) return "";

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeIntegrationUrlError("Integration URL must be a valid absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeIntegrationUrlError("Integration URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new UnsafeIntegrationUrlError("Integration URL must not include credentials");
  }
  return url.toString().replace(/\/$/, "");
}

export function validateOutboundUrl(value: unknown): string {
  const url = validateIntegrationUrl(value);
  if (!url) {
    throw new UnsafeIntegrationUrlError("Integration URL must not be empty");
  }
  return url;
}

// Hostnames/ranges that resolve to the local machine or a private network.
// Trusted integration URLs (admin-configured Grimmory/Chaptarr/Audiobookshelf)
// are allowed to target these — LAN-hosted services are a supported setup.
// Remote cover URLs come from third-party source metadata instead, so they
// get the stricter check below to reduce SSRF exposure.
const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?fe80:/i,
  /^\[?f[cd][0-9a-f]{2}:/i
];

export function validateCoverUrl(value: unknown): string {
  const url = validateOutboundUrl(value);
  const hostname = new URL(url).hostname;
  if (PRIVATE_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname))) {
    throw new UnsafeIntegrationUrlError("Cover URL must not target a private network address");
  }
  return url;
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT (RFC 6598)
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true; // IETF protocol assignments (also covers TEST-NET-1, 192.0.2.0/24) + private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking (RFC 2544)
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2 (RFC 5737, not globally reachable)
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3 (RFC 5737, not globally reachable)
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  // fc00::/7 unique local
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
  // IPv4-mapped (::ffff:0:0/96) — re-check the embedded IPv4 address. DNS can
  // return this in dotted-quad form (::ffff:127.0.0.1) or hex-group form
  // (::ffff:7f00:1 / the expanded 0:0:0:0:0:ffff:7f00:1), so accept both.
  const mapped = normalized.match(
    /^(?:0:0:0:0:0:|::)ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/
  );
  if (mapped) {
    if (mapped[1]) return isPrivateIPv4(mapped[1]);
    const hi = parseInt(mapped[2]!, 16);
    const lo = parseInt(mapped[3]!, 16);
    const dotted = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join(".");
    return isPrivateIPv4(dotted);
  }
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true; // not a recognizable IP literal — fail closed
}

// A hostname string passing validateCoverUrl only rules out literal private
// addresses; a hostname the attacker controls DNS for (e.g. "evil.example.test")
// can still resolve to a private/loopback address. Resolve it and reject if
// any returned address is private, closing that SSRF path.
//
// This does not fully close DNS rebinding (the record could theoretically
// change between this check and the fetch() call below) — that needs pinning
// the HTTP connection to the exact resolved address, which isn't practical
// with Node's built-in fetch without pulling in undici as a direct dependency
// purely for its Agent/dispatcher API. The realistic attack this closes is a
// malicious hostname resolving to a private address, which is the far more
// practical exploitation path than a precisely-timed DNS rebind.
async function ensurePublicHostname(url: string): Promise<void> {
  // URL.hostname wraps IPv6 literals in brackets (e.g. "[2606:4700::1111]");
  // net.isIP() and dns.lookup() both expect the bare address.
  const hostname = new URL(url).hostname.replace(/^\[(.*)\]$/, "$1");
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new UnsafeIntegrationUrlError("Cover URL must not target a private network address");
    }
    return;
  }
  let addresses: string[];
  try {
    addresses = (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  } catch {
    throw new UnsafeIntegrationUrlError(`Cover URL hostname could not be resolved: ${hostname}`);
  }
  if (addresses.length === 0 || addresses.some((address) => isPrivateAddress(address))) {
    throw new UnsafeIntegrationUrlError("Cover URL must not target a private network address");
  }
}

const MAX_REDIRECTS = 5;

// Redirects are followed only when they stay on the same origin as the
// configured integration URL, so a reverse-proxied Grimmory/Audiobookshelf
// instance keeps working while a redirect to an unrelated host is still
// rejected (the SSRF guard `redirect: "error"` used to provide unconditionally).
async function fetchFollowingSameOriginRedirects(url: string, init: RequestInit): Promise<Response> {
  let currentUrl = url;
  const originalOrigin = new URL(url).origin;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const res = await fetch(currentUrl, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.origin !== originalOrigin) {
      throw new UnsafeIntegrationUrlError("Integration redirected to a different origin");
    }
    currentUrl = nextUrl.toString();
  }
  throw new UnsafeIntegrationUrlError("Integration exceeded the maximum number of redirects");
}

export async function fetchIntegration(url: string, init: RequestInit = {}): Promise<Response> {
  return fetchFollowingSameOriginRedirects(validateOutboundUrl(url), init);
}

export async function fetchCoverImage(url: string, init: RequestInit = {}): Promise<Response> {
  const validated = validateCoverUrl(url);
  await ensurePublicHostname(validated);
  return fetchFollowingSameOriginRedirects(validated, init);
}
