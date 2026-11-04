import type { ApiResult, ConflictInfo } from '../../shared/types';

const TOKEN_KEY = 'order-record.token';

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null, remember = false): void {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  if (token) (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
}

export class ApiError extends Error {
  readonly status: number;
  readonly conflict?: ConflictInfo;

  constructor(message: string, status: number, conflict?: ConflictInfo) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.conflict = conflict;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`/api${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as ApiResult<T>;

  if (!res.ok || body.success === false) {
    throw new ApiError(body.error ?? `请求失败（HTTP ${res.status}）`, res.status, body.conflict);
  }
  return body.data as T;
}

async function requestBlob(path: string, init: RequestInit = {}): Promise<{ blob: Blob; filename: string | null }> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `请求失败（HTTP ${res.status}）`, res.status);
  }
  const disposition = res.headers.get('content-disposition');
  const match = disposition?.match(/filename\*=UTF-8''([^;]+)/i);
  return {
    blob: await res.blob(),
    filename: match ? decodeURIComponent(match[1]) : null,
  };
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, data?: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) }),
  patch: <T>(path: string, data?: unknown): Promise<T> =>
    request<T>(path, { method: 'PATCH', body: data === undefined ? undefined : JSON.stringify(data) }),
  postForm: <T>(path: string, data: FormData): Promise<T> => request<T>(path, { method: 'POST', body: data }),
  download: (path: string): Promise<{ blob: Blob; filename: string | null }> => requestBlob(path),
};
