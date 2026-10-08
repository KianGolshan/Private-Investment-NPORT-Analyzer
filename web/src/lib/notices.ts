// Keeping an open tab current on the public site (P9).
//
// - A new deploy: the server's build (/api/config) is checked every 5 minutes
//   and when the tab comes back into view; a different build offers a reload
//   (the tab keeps working meanwhile: a deploy keeps the previous build's
//   assets, deploy/deploy.sh).
// - A missing code chunk (a lazy page from a build that is gone): the page
//   reloads once, so the visitor lands on the current build instead of an error.

const CHECK_MS = 5 * 60 * 1000;

/** The server's build, outside every cache; null when it cannot be read. */
export async function serverBuild(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl('/api/config', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { build?: unknown };
    return typeof body.build === 'string' ? body.build : null;
  } catch {
    return null; // offline or restarting: the next check tries again
  }
}

/**
 * Calls onNew(build) once when the server's build differs from the first one
 * seen. Returns the stop function.
 */
export function watchBuild(
  onNew: (build: string) => void,
  { fetchImpl = fetch, intervalMs = CHECK_MS }: { fetchImpl?: typeof fetch; intervalMs?: number } = {}
): () => void {
  let first: string | null = null;
  let told = false;
  let stopped = false;
  const check = async () => {
    if (stopped || told || document.visibilityState === 'hidden') return;
    const b = await serverBuild(fetchImpl);
    if (b == null || stopped) return;
    if (first == null) first = b;
    else if (b !== first) {
      told = true;
      onNew(b);
    }
  };
  void check();
  const timer = setInterval(check, intervalMs);
  const onVisible = () => void check();
  window.addEventListener('focus', onVisible);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    stopped = true;
    clearInterval(timer);
    window.removeEventListener('focus', onVisible);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

const RELOAD_KEY = 'vantage:chunk-reload';
const RELOAD_WINDOW_MS = 60 * 1000;

/**
 * Reloads the page once for a code chunk that failed to load; true when it did.
 * A second failure within a minute is not reloaded again (a real outage, not a
 * deploy): the error shows instead.
 */
export function reloadOnce({
  now = Date.now(),
  reload = () => window.location.reload(),
}: { now?: number; reload?: () => void } = {}): boolean {
  // without storage a reload could not be remembered (and could repeat): show the error instead
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
    if (now - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

/** A lazy page import that reloads once when its chunk is gone. */
export function withReload<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().catch((err: unknown) => {
      if (reloadOnce()) return new Promise<T>(() => {}); // the page is reloading
      throw err;
    });
}
