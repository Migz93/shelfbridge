async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${url} → ${res.status}${text ? `: ${text}` : ""}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

export const apiGet = <T>(url: string) => request<T>("GET", url);
export const apiPost = <T>(url: string, body?: unknown) => request<T>("POST", url, body);
export const apiPatch = <T>(url: string, body?: unknown) => request<T>("PATCH", url, body);
export const apiDelete = <T>(url: string) => request<T>("DELETE", url);
