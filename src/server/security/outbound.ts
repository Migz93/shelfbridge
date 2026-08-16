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
  return fetchFollowingSameOriginRedirects(validateCoverUrl(url), init);
}
