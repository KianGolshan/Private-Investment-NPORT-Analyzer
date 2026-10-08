// P9 W2: an open tab learns of a new deploy (the server's build changes) and
// offers a reload; a page whose code chunk is gone reloads once, never in a loop.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reloadOnce, serverBuild, watchBuild, withReload } from '../src/lib/notices';

const configOf = (build: unknown, ok = true) =>
  vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => ({ build }) }) as unknown as Response);

afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('serverBuild', () => {
  it('reads the build outside the cache; an error, a bad status or no build is null', async () => {
    const f = configOf('abc');
    expect(await serverBuild(f)).toBe('abc');
    expect(f).toHaveBeenCalledWith('/api/config', expect.objectContaining({ cache: 'no-store' }));
    expect(await serverBuild(configOf('abc', false))).toBeNull();
    expect(await serverBuild(configOf(42))).toBeNull();
    expect(
      await serverBuild(
        vi.fn(async () => {
          throw new Error('offline');
        })
      )
    ).toBeNull();
  });
});

describe('watchBuild', () => {
  it('tells once when the build changes, on the timer and on focus; never for the same build or a failed check', async () => {
    vi.useFakeTimers();
    let build: string | null = 'b1';
    const fetchImpl = vi.fn(async () =>
      build == null
        ? ({ ok: false, status: 503, json: async () => ({}) } as unknown as Response)
        : ({ ok: true, status: 200, json: async () => ({ build }) } as unknown as Response)
    );
    const onNew = vi.fn();
    const stop = watchBuild(onNew, { fetchImpl, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0); // the first check learns b1
    await vi.advanceTimersByTimeAsync(1000);
    expect(onNew).not.toHaveBeenCalled();
    build = null; // restarting during the deploy: not a new build
    await vi.advanceTimersByTimeAsync(1000);
    expect(onNew).not.toHaveBeenCalled();
    build = 'b2';
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onNew).toHaveBeenCalledWith('b2');
    build = 'b3';
    await vi.advanceTimersByTimeAsync(3000);
    expect(onNew).toHaveBeenCalledTimes(1);
    stop();
    const calls = fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });

  it('stopping before the first answer arrives tells nothing', async () => {
    const onNew = vi.fn();
    const stop = watchBuild(onNew, { fetchImpl: configOf('b1'), intervalMs: 1000 });
    stop();
    await new Promise(r => setTimeout(r, 0));
    expect(onNew).not.toHaveBeenCalled();
  });
});

describe('reloadOnce and withReload', () => {
  it('reloads the first time, not again within a minute, and again after it', () => {
    const reload = vi.fn();
    expect(reloadOnce({ now: 1_000_000, reload })).toBe(true);
    expect(reloadOnce({ now: 1_030_000, reload })).toBe(false);
    expect(reloadOnce({ now: 1_061_000, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('without session storage it never reloads (it could not stop a loop)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const reload = vi.fn();
    expect(reloadOnce({ reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a loaded page passes through; a failed one reloads once, then the error shows', async () => {
    expect(await withReload(async () => 'page')()).toBe('page');
    // just reloaded, so no reload now: the error shows
    sessionStorage.setItem('vantage:chunk-reload', String(Date.now()));
    await expect(withReload(async () => Promise.reject(new Error('chunk gone')))()).rejects.toThrow('chunk gone');
  });
});
