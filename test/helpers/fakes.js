// Shared builders for UI tests: the JSON shapes the backend returns, and a
// tiny route-table fetch mock so a test reads as "this URL → this response".

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

// routes: { '/api/search-nport': (params, url) => body | Response-like }
function mockBackend(routes, calls = []) {
  return async url => {
    calls.push(url);
    const u = new URL(url, 'http://localhost');
    const handler = routes[u.pathname];
    if (!handler) return jsonResponse({}, { ok: false, status: 404 });
    const out = await handler(Object.fromEntries(u.searchParams), url);
    return out && typeof out.json === 'function' ? out : jsonResponse(out);
  };
}

function nportHit({ cik = '100', adsh, name, period = '2024-06-30', fileDate }) {
  return {
    _source: {
      ciks: [cik],
      adsh: adsh || `0000000000-24-${cik.padStart(6, '0')}`,
      display_names: [name],
      period_ending: period,
      file_date: fileDate || period,
    },
  };
}

function holding(over = {}) {
  const shares = over.shares ?? 100;
  const pps = over.pps ?? 10;
  return {
    name: over.name || 'ACME INC',
    issuer: over.issuer || '',
    title: over.title || 'ACME INC COM',
    shares,
    marketValue: shares * pps,
    pricePerShare: pps,
    currency: 'USD',
    exchangeRate: 1,
    reportDate: over.reportDate || '2024-06-30',
    cusip: over.cusip || '',
    ticker: '',
    instrumentType: over.instrumentType || 'equity',
    instrumentLabel: over.instrumentLabel || 'Common',
    instrumentKey: over.instrumentKey || over.title || 'ACME INC COM',
    chartValue: over.chartValue ?? pps,
    chartUnit: over.chartUnit || 'usd_per_share',
  };
}

function creditHolding(over = {}) {
  return {
    reportDate: over.reportDate || '2024-06-30',
    portfolioCompany: over.portfolioCompany || 'Acme Aviation',
    industry: 'Aerospace',
    investmentType: 'First Lien Term Loan',
    index: 'SOFR',
    spread: '6.00%',
    cashInterestRate: '11.3%',
    pik: '',
    maturityDate: '06/29',
    shares: '',
    principal: over.principal ?? 1000000,
    cost: over.cost ?? 990000,
    fairValue: over.fairValue ?? 950000,
    fairValueMark: over.fairValueMark ?? 95,
    notes: '',
  };
}

// A full private-fund X-Ray payload (what /api/fund-xray returns) — enough
// shape for buildXraySnapshotHTML / capital-structure rendering.
function xrayPayload(over = {}) {
  return {
    fund: {
      registrantName: 'Test Fund Inc',
      seriesName: 'Test Fund',
      reportDate: '2024-06-30',
      totalAssets: 2e9,
      netAssets: 1.9e9,
    },
    totalHoldingsCount: 100,
    publicHoldingsCount: 98,
    privateHoldingsCount: 2,
    privateValueUSD: 5e6,
    totalValueUSD: 1.9e9,
    privatePctOfNetAssets: 0.26,
    privatePctOfHoldingsValue: 0.26,
    byInstrumentType: { equity: 4e6, derivative: 1e6 },
    byCountry: { US: 5e6 },
    privateHoldings: [
      {
        name: 'ACME INC',
        title: 'ACME INC PFD A',
        instrumentLabel: 'Preferred A',
        country: 'US',
        fairValLevel: '3',
        shares: 1e5,
        pricePerShare: 40,
        pctOfNetAssets: 0.2,
        marketValue: 4e6,
      },
    ],
    topPrivateHoldings: [],
    capitalStructure: [],
    ...over,
  };
}

module.exports = { jsonResponse, mockBackend, nportHit, holding, creditHolding, xrayPayload };
