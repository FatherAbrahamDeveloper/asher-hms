/** Thin API client. Cookies carry the session; the custom header is required by the server's CSRF guard. */
export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export type ActionResult = { ok: boolean; message?: string; fieldErrors?: Record<string, string>; data?: Record<string, any> };

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function parse(res: Response) {
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await res.json() : { ok: res.ok, message: await res.text() };
  if (!res.ok) throw new ApiError(body?.message ?? `Request failed (${res.status})`, res.status);
  return body;
}

export async function get<T = any>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`, { credentials: "include", headers: { Accept: "application/json" } });
  return parse(res);
}

/** POST a form (multipart, so files work everywhere). Returns the server's ActionResult; never throws for 4xx. */
export async function send(path: string, data?: FormData | Record<string, string | number | boolean | undefined | null>): Promise<ActionResult> {
  let fd: FormData;
  if (data instanceof FormData) fd = data;
  else { fd = new FormData(); for (const [k, v] of Object.entries(data ?? {})) if (v !== undefined && v !== null && v !== false) fd.append(k, v === true ? "on" : String(v)); }
  try {
    const res = await fetch(`${API_BASE}/api${path}`, { method: "POST", body: fd, credentials: "include", headers: { "X-Requested-With": "asher-client", Accept: "application/json" } });
    const body = await res.json().catch(() => ({ ok: false, message: `Request failed (${res.status})` }));
    return { ...body, ok: res.ok && body.ok !== false };
  } catch {
    return { ok: false, message: "Cannot reach the server. Check your connection and try again." };
  }
}

export const fileUrl = (rel?: string | null) => (rel ? `${API_BASE}/api/files/${rel}` : null);
export const downloadUrl = (path: string) => `${API_BASE}/api${path}`;
