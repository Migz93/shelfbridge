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
  if (url.search || url.hash) {
    throw new UnsafeIntegrationUrlError("Integration URL must not include a query or fragment");
  }

  return url.toString().replace(/\/$/, "");
}

export async function fetchIntegration(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(validateIntegrationUrl(url), { ...init, redirect: "error" });
}
