import { useEffect, useState } from 'preact/hooks';

// One fetch path for the whole app. Answers are cached by URL for the life of
// one warehouse refresh: the first answer whose refreshId differs from the
// cache's clears it, so a nightly refresh never serves yesterday's numbers.
// Every request in a hook is aborted when its inputs change, so a slow answer
// can never overwrite a newer one (v1's views.js had no such guard).

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const cache = new Map<string, unknown>();
let cacheRefreshId: number | null = null;

export function qs(params: Record<string, string | number | boolean | null | undefined | string[]>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || v === false) continue;
    if (Array.isArray(v)) v.forEach(x => sp.append(k, x));
    else sp.set(k, v === true ? '1' : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  if (cache.has(url)) return cache.get(url) as T;
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // a non-JSON error page; reported below by status
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error || `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status);
  }
  const rid = (body as { refreshId?: number } | null)?.refreshId;
  if (typeof rid === 'number' && rid !== cacheRefreshId) {
    cache.clear();
    cacheRefreshId = rid;
  }
  cache.set(url, body);
  return body as T;
}

export interface ApiState<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
}

/** Fetches `url` (null = nothing to fetch) and re-fetches when it changes. */
export function useApi<T>(url: string | null): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>(() => ({
    data: url && cache.has(url) ? (cache.get(url) as T) : null,
    error: null,
    loading: !!url && !cache.has(url),
  }));
  useEffect(() => {
    if (!url) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    if (cache.has(url)) {
      setState({ data: cache.get(url) as T, error: null, loading: false });
      return;
    }
    const ctl = new AbortController();
    setState(s => ({ data: s.data, error: null, loading: true }));
    getJSON<T>(url, ctl.signal).then(
      data => setState({ data, error: null, loading: false }),
      error => {
        if (ctl.signal.aborted) return;
        setState({ data: null, error, loading: false });
      }
    );
    return () => ctl.abort();
  }, [url]);
  return state;
}

/** Test hook: forget every cached answer. */
export function clearApiCache(): void {
  cache.clear();
  cacheRefreshId = null;
}
