import dns from "node:dns/promises";
import net from "node:net";
import { Agent } from "undici";

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
export function validateCoverUrl(value: unknown): string {
  const url = validateOutboundUrl(value);
  const hostname = new URL(url).hostname.replace(/^\[(.*)\]$/, "$1");
  if (hostname.toLowerCase() === "localhost" || (net.isIP(hostname) && isPrivateAddress(hostname))) {
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

// Expands any valid textual IPv6 address (any "::" compression point, with or
// without an embedded trailing IPv4 dotted quad) to its 8 canonical 16-bit
// hex groups. Returns null if the address isn't structurally valid.
function expandIPv6Groups(address: string): string[] | null {
  const withoutZone = address.split("%")[0]!;
  const sides = withoutZone.split("::");
  if (sides.length > 2) return null; // more than one "::" is never valid

  const parseSide = (side: string): string[] | null => {
    if (side === "") return [];
    const groups = side.split(":");
    const last = groups[groups.length - 1]!;
    if (last.includes(".")) {
      const octets = last.split(".");
      if (octets.length !== 4) return null;
      const nums = octets.map(Number);
      if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
      const hi = (((nums[0]! << 8) | nums[1]!) >>> 0).toString(16);
      const lo = (((nums[2]! << 8) | nums[3]!) >>> 0).toString(16);
      groups.splice(groups.length - 1, 1, hi, lo);
    }
    return groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g)) ? groups : null;
  };

  const left = parseSide(sides[0]!);
  const right = sides.length === 2 ? parseSide(sides[1]!) : [];
  if (left === null || right === null) return null;

  let groups: string[];
  if (sides.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    if (left.length !== 8) return null;
    groups = left;
  }
  return groups.length === 8 ? groups.map((g) => g.toLowerCase().padStart(4, "0")) : null;
}

function ipv4FromGroups(hiGroup: string, loGroup: string): string {
  const hi = parseInt(hiGroup, 16);
  const lo = parseInt(loGroup, 16);
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join(".");
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  // fec0::/10 site-local — deprecated by RFC 3879 but still parseable
  if (/^fe[c-f][0-9a-f]:/.test(normalized)) return true;
  // fc00::/7 unique local
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
  // ff00::/8 multicast — never a valid outbound HTTP target
  if (/^ff[0-9a-f]{2}:/.test(normalized)) return true;

  const groups = expandIPv6Groups(normalized);
  // net.isIP() already validated this as syntactically valid IPv6 before
  // isPrivateAddress ever calls this function, so expandIPv6Groups failing
  // to parse it here would mean a gap between the two parsers — fail closed
  // (treat as private) rather than letting an unrecognized form through as
  // if it were a confirmed-public address.
  if (!groups) return true;

  // 2001:db8::/32 — reserved for documentation, never globally routable.
  if (groups[0] === "2001" && groups[1] === "0db8") return true;

  // Addresses that embed an IPv4 address somewhere in their bits — re-check
  // that embedded address:
  //   - IPv4-mapped (::ffff:0:0/96) / IPv4-compatible (::0:0/96, deprecated
  //     by RFC 4291 but still parseable), embedded in the last 32 bits
  //   - NAT64 well-known prefix (64:ff9b::/96) — a DNS64 resolver can
  //     synthesize one of these for a private-IPv4 target — last 32 bits
  if ((groups.slice(0, 5).every((g) => g === "0000") && (groups[5] === "ffff" || groups[5] === "0000")) ||
      (groups[0] === "0064" && groups[1] === "ff9b" && groups.slice(2, 6).every((g) => g === "0000"))) {
    return isPrivateIPv4(ipv4FromGroups(groups[6]!, groups[7]!));
  }
  // RFC 8215 local-use NAT64. Its embedded IPv4 offset varies, so reject the
  // whole prefix rather than attempting to extract a potentially private IP.
  if (groups[0] === "0064" && groups[1] === "ff9b" && groups[2] === "0001") return true;
  // 2002::/16 — 6to4, embeds the IPv4 in bits 16-48 (groups 1-2)
  if (groups[0] === "2002") {
    return isPrivateIPv4(ipv4FromGroups(groups[1]!, groups[2]!));
  }
  // 2001:0000::/32 — Teredo (RFC 4380), embeds the client's IPv4 in the last
  // 32 bits, bit-inverted (XORed with 0xffffffff) to discourage NAT
  // rewriting it in transit.
  if (groups[0] === "2001" && groups[1] === "0000") {
    const hi = (~parseInt(groups[6]!, 16)) & 0xffff;
    const lo = (~parseInt(groups[7]!, 16)) & 0xffff;
    return isPrivateIPv4(ipv4FromGroups(hi.toString(16), lo.toString(16)));
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
// fetchCoverImage also uses the connector lookup below, which validates the
// address supplied to the eventual socket and closes the DNS-rebinding window.
// This initial check still rejects unsafe URLs before they reach that transport.
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

// The global fetch performs its own DNS lookup after ensurePublicHostname()
// returns, leaving a rebinding window. This lookup is passed to Undici's
// connector, so the address it validates is the address the socket uses.
type LookupAddress = { address: string; family: number };

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number
) => void;

export function lookupPublicAddress(
  hostname: string,
  options: { family?: number; hints?: number; all?: boolean },
  callback: LookupCallback
): void {
  void dns.lookup(hostname, {
    all: true,
    verbatim: true,
    ...(options.family ? { family: options.family } : {}),
    ...(options.hints ? { hints: options.hints } : {})
  }).then((addresses) => {
    if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
      callback(new UnsafeIntegrationUrlError("Cover URL must not target a private network address") as NodeJS.ErrnoException);
      return;
    }
    // Node 20+ asks custom lookups for all candidates so its connector can
    // apply Happy Eyeballs. Its callback requires an address array in that
    // mode; returning the legacy single-address shape makes net.connect()
    // reject with ERR_INVALID_IP_ADDRESS before opening the socket.
    if (options.all) {
      callback(null, addresses.map(({ address, family }) => ({ address, family })));
      return;
    }
    const address = addresses[0]!;
    callback(null, address.address, address.family);
  }).catch(() => {
    callback(new UnsafeIntegrationUrlError("Cover URL hostname could not be resolved") as NodeJS.ErrnoException);
  });
}

// Undici's runtime connector supports Node's lookup option, although its v7
// declaration omits it. Keep this dispatcher limited to untrusted cover URLs.
const coverDispatcher = new Agent({
  connect: { lookup: lookupPublicAddress } as never
});

// Fetch implementations can wrap connector failures more than once. Preserve
// the specific SSRF rejection so callers do not mistake it for a generic
// network error, regardless of the Undici version supplying fetch.
function findUnsafeIntegrationUrlError(error: unknown): UnsafeIntegrationUrlError | null {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof UnsafeIntegrationUrlError) return current;
    seen.add(current);
    current = current.cause;
  }
  return null;
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
    // This response is a redirect being followed or rejected, not returned to
    // the caller — its body is never read, so it must be released here or the
    // connection stays pooled until GC for every hop of a redirect chain.
    // Best-effort: an already-errored body (e.g. a connection drop after
    // headers) rejects on cancel() too, and that must not fail an otherwise
    // valid redirect.
    await res.body?.cancel().catch(() => {});
    if (nextUrl.origin !== originalOrigin) {
      throw new UnsafeIntegrationUrlError("Integration redirected to a different origin");
    }
    currentUrl = nextUrl.toString();
  }
  throw new UnsafeIntegrationUrlError("Integration exceeded the maximum number of redirects");
}

// Cover URLs come from third-party metadata and commonly redirect to a CDN.
// Unlike configured integration URLs, each cross-origin hop is acceptable if
// it independently passes the cover-specific public-address checks.
async function fetchFollowingPublicCoverRedirects(url: string, init: RequestInit): Promise<Response> {
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    let res: Response;
    try {
      res = await fetch(currentUrl, {
        ...init,
        dispatcher: coverDispatcher,
        redirect: "manual"
      } as RequestInit);
    } catch (error) {
      const unsafeError = findUnsafeIntegrationUrlError(error);
      if (unsafeError) throw unsafeError;
      throw error;
    }
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    try {
      const nextUrl = new URL(location, currentUrl);
      const validatedNextUrl = validateCoverUrl(nextUrl.toString());
      await ensurePublicHostname(validatedNextUrl);
      currentUrl = validatedNextUrl;
    } finally {
      await res.body?.cancel().catch(() => {});
    }
  }
  throw new UnsafeIntegrationUrlError("Cover URL exceeded the maximum number of redirects");
}

export async function fetchIntegration(url: string, init: RequestInit = {}): Promise<Response> {
  return fetchFollowingSameOriginRedirects(validateOutboundUrl(url), init);
}

export async function fetchCoverImage(url: string, init: RequestInit = {}): Promise<Response> {
  const validated = validateCoverUrl(url);
  await ensurePublicHostname(validated);
  return fetchFollowingPublicCoverRedirects(validated, init);
}
