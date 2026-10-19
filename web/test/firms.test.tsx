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

function serve() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => (String(url).startsWith('/api/firms') ? list : { newestReportDate: '2026-09-30' }),
    }))
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
    expect(text).toContain('$15.0M held by 2 funds across all firms');
    expect(text).toContain('do not add up');
    // the sum of firm values ($20.0M) appears nowhere
    expect(text).not.toContain('$20.0M');
    const foot = container.querySelector('tfoot')?.textContent ?? '';
    expect(foot).toContain('2 firms');
    expect(foot).not.toMatch(/\$/);
  });
});
