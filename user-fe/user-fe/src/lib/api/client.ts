export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3005";

/** Thrown by `apiFetch` for any non-2xx response. `message` mirrors what the
 *  UI already showed before this layer existed: the backend's ProblemJSON
 *  `message`/`detail`/`error` field, or a caller-supplied fallback. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

interface ApiFetchOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Omitted entirely when null/undefined, matching every existing call site
   *  that only sends a bearer header when a token is actually available. */
  token?: string | null;
  body?: unknown;
  /** Used when the response is non-ok and carries no message/detail/error
   *  field of its own — mirrors each call site's previous hardcoded fallback. */
  fallbackMessage?: string;
}

/**
 * The CSRF header every cookie-authenticated write must carry (`x-orebit-csrf`), read from the `orebit_csrf`
 * cookie the auth sets. Without it the server answers 403 on reports, preferences and uploads.
 */
export function csrfHeaders(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const match = document.cookie.match(/(?:^|;\s*)orebit_csrf=([^;]+)/);
  return match ? { "x-orebit-csrf": decodeURIComponent(match[1]) } : {};
}

/** The most useful text in a problem response: the first field error, else the detail. */
export function problemMessage(data: any, fallback: string): string {
  const fieldError = Array.isArray(data?.errors) && data.errors[0]?.message;
  return fieldError || data?.message || data?.detail || data?.error || fallback;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  // The session cookie is the only credential (D-06); `token` is no longer sent as a bearer.
  const headers: Record<string, string> = { ...csrfHeaders() };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    credentials: "include",
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const message = problemMessage(data, options.fallbackMessage || `Request failed (${res.status})`);
    throw new ApiError(res.status, message, data);
  }

  return data as T;
}
