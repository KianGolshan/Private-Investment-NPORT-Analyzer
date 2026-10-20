// Review 2026-10-18 #4: a fund with two advisers counts in full for each firm,
// so the Firms table never sums firm values. The all-firms total comes from
// the same /api/firms answer (uniqueValue, each fund once; LESSONS 39).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/preact';
import { LocationProvider } from 'preact-iso';
import { clearApiCache } from '../src/api/client';
import type { FirmList } from '../src/api/types';
import Firms from '../src/pages/Firms';

const list: FirmList = {
  source: 'warehouse',
  refreshId: 1,
  date: '2026-09-30',
  count: 2,
  // fund F is advised by both firms: $5M counts for each, once here
  uniqueValue: 15_000_000,
  uniqueFunds: 2,
  results: [
    { id: 1, name: 'Firm A', fundsManaged: 2, fundsHolding: 2, companies: 2, value: 15_000_000 },
    { id: 2, name: 'Firm B', fundsManaged: 1, fundsHolding: 1, companies: 1, value: 5_000_000 },
  ],
} as unknown as FirmList;

let asked: string[] = [];
function serve() {
  asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) => (
        asked.push(String(url)),
        {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => (String(url).startsWith('/api/firms') ? list : { newestReportDate: '2026-09-30' }),
        }
      )
    )
  );
}
afterEach(() => {
  clearApiCache();
  vi.unstubAllGlobals();
});

describe('Firms', () => {
  it('states the all-firms total once per fund and never sums firm values in the footer', async () => {
    serve();
    const { container } = render(
      <LocationProvider>
        <Firms />
      </LocationProvider>
    );
    await waitFor(() => expect(container.textContent).toContain('held by 2 funds across all firms'));
    const text = container.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('$15.0M in private companies held by 2 funds across all firms');
    expect(text).toContain('do not add up');
    // the sum of firm values ($20.0M) appears nowhere
    expect(text).not.toContain('$20.0M');
    const foot = container.querySelector('tfoot')?.textContent ?? '';
    expect(foot).toContain('2 firms');
    expect(foot).not.toMatch(/\$/);
  });
});

// Review 2026-10-18 W3/W4: operating companies by default (like Market), every
// private holding on ?show=all; "known by" only with a past as-of date.
describe('Firms: category and known by', () => {
  const at = (url: string) => {
    window.history.replaceState(null, '', url);
    return render(
      <LocationProvider>
        <Firms />
      </LocationProvider>
    );
  };
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('asks for operating companies by default and every holding on ?show=all', async () => {
    serve();
    at('/firms');
    await waitFor(() => expect(asked.some(u => u.startsWith('/api/firms'))).toBe(true));
    expect(asked.find(u => u.startsWith('/api/firms'))).toContain('category=company');
    expect(asked.find(u => u.startsWith('/api/firms'))).not.toContain('known=');
    clearApiCache();
    serve();
    at('/firms?show=all');
    await waitFor(() => expect(asked.some(u => u.startsWith('/api/firms'))).toBe(true));
    expect(asked.find(u => u.startsWith('/api/firms'))).not.toContain('category=');
  });

  it('offers "filed by" only with a past as-of date, and sends known=1 when picked', async () => {
    serve();
    const latest = at('/firms');
    await waitFor(() => expect(latest.container.textContent).toContain('across all firms'));
    expect(latest.container.textContent).not.toContain('Filed by');
    latest.unmount();
    clearApiCache();
    serve();
    const past = at('/firms?asof=2026-06-30&known=1');
    await waitFor(() => expect(past.container.textContent).toContain('Filed by'));
    expect(asked.find(u => u.startsWith('/api/firms'))).toContain('known=1');
    expect(past.container.textContent).toContain('Only reports filed with the SEC by');
  });
});
