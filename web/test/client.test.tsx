// Staff review F02: a session left open through a refresh learns the new
// generation (focus, visibility, a timer) and never keeps yesterday's answers;
// an answer from an older generation never replaces a newer one.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/preact';
import { clearApiCache, getJSON, revalidate, useApi } from '../src/api/client';

let generation = 1;
let calls: string[] = [];
const ok = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body });
function serve(answer: (url: string) => unknown = url => ({ refreshId: generation, url })) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return ok(url === '/api/freshness' ? { refreshId: generation } : answer(url));
    })
  );
}
afterEach(() => {
  clearApiCache();
  vi.unstubAllGlobals();
  generation = 1;
});

describe('api client freshness', () => {
  it('a cached URL is served from memory until the generation changes, then fetched again', async () => {
    serve();
    expect(((await getJSON('/probe')) as { refreshId: number }).refreshId).toBe(1);
    expect(((await getJSON('/probe')) as { refreshId: number }).refreshId).toBe(1);
    expect(calls).toEqual(['/probe']);
    generation = 2; // a refresh published while the tab stayed open
    await revalidate();
    expect(((await getJSON('/probe')) as { refreshId: number }).refreshId).toBe(2);
    expect(calls).toEqual(['/probe', '/api/freshness', '/probe']);
  });

  it('an answer from an older generation is fetched again and never cached over a newer one', async () => {
    generation = 5;
    serve();
    await getJSON('/a');
    // the next answer for /b comes from generation 4 (raced the refresh), then 5
    let n = 0;
    serve(url => ({ refreshId: url === '/b' && n++ === 0 ? 4 : 5, url }));
    expect(((await getJSON('/b')) as { refreshId: number }).refreshId).toBe(5);
    expect(calls).toEqual(['/b', '/b']);
    // /a stays cached: generation 5 never moved backward
    await getJSON('/a');
    expect(calls).toEqual(['/b', '/b']);
  });

  it('a mounted view refetches when a newer generation is seen', async () => {
    serve();
    function View() {
      const s = useApi<{ refreshId: number }>('/view');
      return <span data-testid="v">{s.data ? s.data.refreshId : '…'}</span>;
    }
    const { getByTestId } = render(<View />);
    await waitFor(() => expect(getByTestId('v').textContent).toBe('1'));
    generation = 2;
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(getByTestId('v').textContent).toBe('2'));
  });
});
