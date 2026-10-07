// P6d W2 (staff full-stack review R13, R16): the X-Ray says what a capped list
// leaves out with the counts the service sends ({ shown, privateHoldings,
// notPrivate }, lib/services/fund.js forDisplay), and never labels a share of
// total holdings value as a share of net assets.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/preact';
import { LocationProvider } from 'preact-iso';
import { clearApiCache } from '../src/api/client';
import type { FundFilings, Xray, XrayHolding } from '../src/api/types';
import { XRay } from '../src/pages/fund/XRay';

const fund: FundFilings = {
  source: 'warehouse',
  refreshId: 1,
  fund: { fundKey: 'S000000001', cik: '1', seriesId: 'S000000001', registrant: 'Test Trust', seriesName: 'Test Fund' },
  filings: [
    {
      accession: '0000000001-26-000001',
      reportDate: '2026-06-30',
      filingDate: '2026-08-28',
      form: 'NPORT-P',
      source: 'edgar',
      versions: 1,
      netAssets: 0,
    },
  ],
} as unknown as FundFilings;

const holding = (i: number): XrayHolding =>
  ({
    name: `Company ${i}`,
    title: 'Common',
    shares: 10,
    marketValue: 1000 - i,
    pricePerShare: 100,
    unit: 'NS',
    perShare: true,
    instrumentType: 'equity',
    instrumentLabel: 'Common',
    instrumentKey: `K${i}`,
    filerId: null,
    fairValLevel: '3',
    isRestrictedSec: 'Y',
    pctOfNetAssets: null,
    country: 'US',
    rowKey: `r${i}`,
    privateKind: 'company',
    company: null,
    unreviewed: { key: `K${i}` },
    labels: [],
  }) as XrayHolding;

function xray(over: Partial<Xray['xray']>): Xray {
  return {
    source: 'warehouse',
    refreshId: 1,
    fund: fund.fund,
    xray: {
      fund: { seriesName: 'Test Fund', registrantName: 'Test Trust', reportDate: '2026-06-30', netAssets: 0 },
      filing: { ...fund.filings[0], cik: '1' },
      markDate: '2026-06-30',
      accession: '0000000001-26-000001',
      totalHoldingsCount: 3000,
      publicHoldingsCount: 500,
      privateHoldingsCount: 2500,
      privateValueUSD: 2_000_000,
      privateByKind: {
        company: { label: 'Operating companies', rows: 2500, valueUSD: 2_000_000 },
        fund: { label: 'Fund interests', rows: 0, valueUSD: 0 },
        vehicle: { label: 'Opaque vehicles', rows: 0, valueUSD: 0 },
      },
      totalValueUSD: 8_000_000,
      privatePctOfNetAssets: null,
      privatePctOfHoldingsValue: 25,
      listedValueUSD: 0,
      debtValueUSD: 0,
      byCountry: {},
      privateHoldings: [holding(1), holding(2)],
      notPrivate: [],
      capitalStructure: [],
      truncated: { shown: 2, privateHoldings: 2500, notPrivate: 0 },
      ...over,
    },
  } as unknown as Xray;
}

function serve(body: Xray) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }))
  );
}
afterEach(() => {
  clearApiCache();
  vi.unstubAllGlobals();
});
const show = () =>
  render(
    <LocationProvider>
      <XRay fund={fund} name="Test Fund" />
    </LocationProvider>
  );

describe('Fund X-Ray', () => {
  it('a capped list says how many private rows the filing has and which are shown (R16)', async () => {
    serve(xray({}));
    const { container } = show();
    await waitFor(() => expect(container.querySelector('.notice.warn')).toBeTruthy());
    const text = container.querySelector('.notice.warn')!.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('largest 2 rows by value');
    expect(text).toContain('2 of 2,500 private rows');
    expect(text).not.toContain('undefined');
  });

  it('net assets not positive: the share is of holdings value, said so, never "of net assets" (R13)', async () => {
    serve(xray({ truncated: null }));
    const { container } = show();
    await waitFor(() => expect(container.textContent).toContain('of holdings value (net assets not positive)'));
    expect(container.textContent).not.toMatch(/% of net assets/);
    expect(container.querySelector('.notice.warn')).toBeNull();
  });
});
