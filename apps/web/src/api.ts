/** Error carrying the API's error code (e.g. `invalid_credentials`) for translated messages. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(code);
  }
}

/**
 * Same-origin JSON calls. Every request carries the CSRF header the API requires; the session
 * lives in an HttpOnly cookie that JavaScript never sees.
 */
export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-skydra-csrf': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(data.error ?? 'unknown', res.status, data.message);
  return data as T;
}

export type Membership = {
  organizationId: string;
  organizationName: string;
  planCode: 'INDIVIDUAL' | 'AGENCY' | 'AGENCY_PRO';
  roles: string[];
  permissions: string[];
};

export type Me = {
  user: { id: string; email: string; fullName: string };
  isPlatformAdmin: boolean;
  memberships: Membership[];
  activeOrganizationId: string | null;
};

/**
 * Downloads a file the API produces on POST (e.g. a registered case export) and hands it to the
 * browser as a download. Returns the SHA-256 the API reported for the file.
 */
export async function apiDownload(path: string, fallbackName: string): Promise<string | null> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-skydra-csrf': '1' },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(data.error ?? 'unknown', res.status, data.message);
  }
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
  return res.headers.get('x-content-sha256');
}
