import { useEffect, useRef, useState } from 'preact/hooks';

// One fetch path for the whole app. Answers are cached by URL for the life of
// one published warehouse generation (refreshId). The generation is learned
// from every answer and re-checked on its own: when the tab regains focus or
// becomes visible, and every 5 minutes (staff review F02). A newer generation
// clears the cache and tells every mounted useApi to fetch again, so a session
// left open through a refresh never keeps serving yesterday's numbers. An answer
// from an older generation than one already seen (a slow response that raced a
// refresh) is fetched again, never cached. Every request in a hook is aborted
// when its inputs change, so a slow answer can never overwrite a newer one.

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
const listeners = new Set<() => void>();
const REVALIDATE_MS = 5 * 60 * 1000;

/** Takes a generation id seen on an answer. Returns false when it is older than the current one. */
function adopt(rid: unknown): boolean {
  if (typeof rid !== 'number') return true;
  if (cacheRefreshId != null && rid < cacheRefreshId) return false;
  if (rid !== cacheRefreshId) {
    const first = cacheRefreshId == null;
    cache.clear();
    cacheRefreshId = rid;
    if (!first) for (const fn of [...listeners]) fn();
  }
  return true;
}

// Per-URL updates of a cached answer without a new generation: the last job's
// state moves on its own (running, failed, published with warnings; Codex
// verification V05), so /api/freshness is refreshed in place and its views
// re-render.
const urlListeners = new Map<string, Set<(body: unknown) => void>>();
function replaceCached(url: string, body: unknown): void {
  cache.set(url, body);
  for (const fn of [...(urlListeners.get(url) ?? [])]) fn(body);
}

// While the server warms a newer generation (P9: it keeps answering from the
// old one until the swap), ask again this often, up to SWITCH_TRIES times.
const SWITCH_RETRY_MS = 2000;
const SWITCH_TRIES = 30;
let switchTries = 0;
let switchTimer: ReturnType<typeof setTimeout> | null = null;

/** Asks the server which generation it serves, outside the answer cache. */
export async function revalidate(): Promise<void> {
  try {
    const res = await fetch('/api/freshness', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const body = (await res.json()) as { refreshId?: number; job?: unknown; switching?: boolean };
    const before = cache.get('/api/freshness') as { job?: unknown } | undefined;
    if (adopt(body.refreshId) && JSON.stringify(before?.job) !== JSON.stringify(body.job))
      replaceCached('/api/freshness', body);
    if (body.switching && switchTries < SWITCH_TRIES && !switchTimer) {
      switchTries++;
      switchTimer = setTimeout(() => {
        switchTimer = null;
        void revalidate();
      }, SWITCH_RETRY_MS);
    } else if (!body.switching) switchTries = 0;
  } catch {
    // offline or the server is restarting: try again on the next trigger
  }
}

let watching = false;
function watchFreshness(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  const check = () => {
    if (document.visibilityState === 'visible') void revalidate();
  };
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
  setInterval(check, REVALIDATE_MS);
}

/** Calls fn whenever a newer generation is seen; returns the unsubscribe. */
export function onGeneration(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

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
  for (let attempt = 0; ; attempt++) {
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
    const current = adopt((body as { refreshId?: number } | null)?.refreshId);
    // an older generation than one already seen: ask once more, else show it uncached
    if (!current && attempt === 0) continue;
    if (current) cache.set(url, body);
    return body as T;
  }
}

export interface ApiState<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
}

/** Fetches `url` (null = nothing to fetch) and re-fetches when it changes or a newer generation is published. */
export function useApi<T>(url: string | null): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>(() => ({
    data: url && cache.has(url) ? (cache.get(url) as T) : null,
    error: null,
    loading: !!url && !cache.has(url),
  }));
  const [gen, setGen] = useState(0);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    watchFreshness();
    return onGeneration(() => setGen(g => g + 1));
  }, []);
  useEffect(() => {
    if (!url) return;
    const fn = (body: unknown) => setState({ data: body as T, error: null, loading: false });
    const set = urlListeners.get(url) ?? urlListeners.set(url, new Set()).get(url)!;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }, [url]);
  useEffect(() => {
    if (!url) {
      shown.current = null;
      setState({ data: null, error: null, loading: false });
      return;
    }
    if (cache.has(url)) {
      shown.current = url;
      setState({ data: cache.get(url) as T, error: null, loading: false });
      return;
    }
    const ctl = new AbortController();
    // never show the previous URL's answer under the new one; the same URL in
    // a newer generation keeps its answer on screen until the new one arrives
    if (shown.current === url) setState(s => ({ ...s, loading: true }));
    else setState({ data: null, error: null, loading: true });
    getJSON<T>(url, ctl.signal).then(
      data => {
        if (ctl.signal.aborted) return;
        shown.current = url;
        setState({ data, error: null, loading: false });
      },
      error => {
        if (ctl.signal.aborted) return;
        setState({ data: null, error, loading: false });
      }
    );
    return () => ctl.abort();
  }, [url, gen]);
  return state;
}

/** Test hook: forget every cached answer. */
export function clearApiCache(): void {
  if (switchTimer) clearTimeout(switchTimer);
  switchTimer = null;
  switchTries = 0;
  cache.clear();
  cacheRefreshId = null;
  listeners.clear();
  urlListeners.clear();
}
