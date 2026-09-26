// LIVE end-to-end tests against the real SEC EDGAR — real filings, real
// network, the real Express app, and (for the UI tests) the real frontend in
// jsdom wired to that live backend. Nothing is mocked.
//
// Opt-in, because it hits sec.gov and takes a few minutes:
//
//     npm run test:live        (equivalent to LIVE_SEC=1 node --test test/live-e2e.test.js)
//
// Skipped by default so `npm test` stays fast and offline. Requires a real
// SEC_USER_AGENT in .env (SEC's fair-access policy).
//
// Assertions are INVARIANTS, not pinned values: live data changes every
// quarter, so these check structure and internal consistency (totals reconcile,
// identities hold, no NaN, nothing dropped or double-counted) rather than
// specific dollar figures.

process.env.CACHE_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const LIVE = process.env.LIVE_SEC === '1';
const app = LIVE ? require('../server') : null;
const HAS_UA = LIVE && !!process.env.SEC_USER_AGENT;
const skip = !LIVE
  ? 'set LIVE_SEC=1 (npm run test:live) to run against the real SEC'
  : !HAS_UA
    ? 'SEC_USER_AGENT not configured'
    : false;
const T = { skip, timeout: 240000 };

const { loadApp } = LIVE ? require('./helpers/loadApp') : {};

const finite = v => typeof v === 'number' && Number.isFinite(v);
const get = async url => {
  const res = await request(app).get(url);
  assert.equal(res.status, 200, `${url} → ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return res.body;
};

// Shared across tests (each is expensive): the SMALLCAP World Fund history.
let fundCache;
async function smallcap() {
  if (fundCache) return fundCache;
  const search = await get('/api/search-fund?fund=' + encodeURIComponent('SMALLCAP World Fund'));
  const match = search.matches.find(m => m.filings.length >= 4);
  assert.ok(match, 'expected SMALLCAP World Fund with 4+ NPORT-P filings');
  const filings = [...match.filings].sort((a, b) => b.reportDate.localeCompare(a.reportDate));
  fundCache = { cik: match.cik, name: match.name, filings };
  return fundCache;
}

// ── backend, real SEC ───────────────────────────────────────────────────────

test('LIVE search-nport: a real private name returns well-formed filing hits', T, async () => {
  const body = await get('/api/search-nport?security=Databricks');
  const hits = body.hits.hits;
  assert.ok(hits.length >= 5, `expected many funds mentioning Databricks, got ${hits.length}`);
  for (const h of hits.slice(0, 20)) {
    assert.ok(h._source.adsh, 'accession present');
    assert.ok(h._source.ciks?.length, 'CIK present');
    assert.ok(h._source.display_names?.[0], 'fund name present');
  }
});

test(
  'LIVE parse-nport: parsed holdings are internally consistent (price = value / shares, sane currency, known types)',
  T,
  async () => {
    const search = await get('/api/search-nport?security=Databricks');
    let checked = 0;
    for (const hit of search.hits.hits.slice(0, 6)) {
      const { ciks, adsh } = hit._source;
      const body = await get(`/api/parse-nport?cik=${ciks[0]}&accession=${adsh}&security=Databricks`);
      assert.equal(body.success, true, body.error);
      for (const h of body.holdings) {
        assert.ok(finite(h.shares) && h.shares > 0);
        assert.ok(finite(h.marketValue) && h.marketValue > 0);
        assert.ok(close(h.pricePerShare, h.marketValue / h.shares), 'pricePerShare = marketValue/shares');
        assert.match(h.currency, /^[A-Z]{3}$/);
        assert.ok(['equity', 'debt', 'derivative', 'indirect'].includes(h.instrumentType));
        assert.match(h.reportDate, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(!/\[object Object\]/.test(JSON.stringify(h)), 'no [object Object] leaks');
        checked++;
      }
    }
    assert.ok(checked > 0, 'at least one real holding parsed');
  }
);

test('LIVE search-fund: resolves a registrant by name with a real filing history', T, async () => {
  const f = await smallcap();
  assert.match(f.name, /SMALLCAP/i);
  assert.ok(f.filings.length >= 4);
  f.filings.forEach(x => assert.match(x.accession, /^\d{10}-\d{2}-\d{6}$/));
});

test(
  'LIVE fund-xray: the private book reconciles (exposure ≤ total, breakdowns sum, capital structure adds up)',
  T,
  async () => {
    const f = await smallcap();
    const { xray } = await get(`/api/fund-xray?cik=${f.cik}&accession=${f.filings[0].accession}`).then(b => {
      assert.equal(b.success, true, b.error);
      return b;
    });

    assert.ok(xray.totalHoldingsCount > 50);
    assert.equal(xray.privateHoldingsCount, xray.privateHoldings.length);
    assert.ok(xray.privateValueUSD >= 0 && xray.privateValueUSD <= xray.totalValueUSD);
    const byType = Object.values(xray.byInstrumentType).reduce((a, b) => a + b, 0);
    const byCountry = Object.values(xray.byCountry).reduce((a, b) => a + b, 0);
    assert.ok(close(byType, xray.privateValueUSD, 1), 'instrument-type breakdown sums to private value');
    assert.ok(close(byCountry, xray.privateValueUSD, 1), 'country breakdown sums to private value');
    assert.ok(
      xray.privateHoldings.every(p => p.isPrivate && p.instrumentType !== 'debt'),
      'private equity book never contains debt'
    );
    if (xray.fund.netAssets > 0) assert.ok(xray.privatePctOfNetAssets < 100);

    const privateIssuerValue = xray.capitalStructure.reduce((s, c) => s + c.totalValueUSD, 0);
    assert.ok(
      privateIssuerValue >= xray.privateValueUSD - 1,
      'capital structure covers at least the whole private equity book'
    );
    for (const c of xray.capitalStructure) {
      assert.ok(
        close(
          c.totalValueUSD,
          c.instruments.reduce((s, i) => s + i.marketValue, 0),
          1
        ),
        `${c.issuer}: instruments sum to issuer total`
      );
      assert.equal(c.multiTranche, Object.keys(c.byType).length > 1);
      for (let i = 1; i < c.instruments.length; i++)
        assert.ok(c.instruments[i - 1].seniority <= c.instruments[i].seniority, 'senior first');
    }
  }
);

test(
  'LIVE fund-xray-compare: price effect + share effect + other exactly reconciles to the value change of held positions',
  T,
  async () => {
    const f = await smallcap();
    const [cur, pri] = f.filings;
    const { comparison } = await get(
      `/api/fund-xray-compare?cik=${f.cik}&currentAccession=${cur.accession}&priorAccession=${pri.accession}`
    );
    const held = comparison.positions.filter(p => p.status === 'held');
    const heldDelta = held.reduce((s, p) => s + (p.marketValue.delta || 0), 0);
    const t = comparison.totals;
    const decomposed = t.valueChangeFromPrice.amount + t.valueChangeFromShares.amount + t.valueChangeOther.amount;
    assert.ok(
      close(decomposed, heldDelta, Math.max(1, Math.abs(heldDelta) * 1e-9)),
      `decomposition ${decomposed} vs held delta ${heldDelta}`
    );
    assert.equal(t.newCount + t.continuingCount, comparison.positions.filter(p => p.status !== 'exited').length);
    assert.equal(t.exitedCount, comparison.positions.filter(p => p.status === 'exited').length);
    assert.ok(close(t.privateValueUSD.delta, t.privateValueUSD.current - t.privateValueUSD.prior, 1));
  }
);

test('LIVE fund-xray-returns: lot accounting is self-consistent on a real 4-filing history', T, async () => {
  const f = await smallcap();
  const accessions = f.filings
    .slice(0, 4)
    .map(x => x.accession)
    .join(',');
  const { returns } = await get(`/api/fund-xray-returns?cik=${f.cik}&accessions=${accessions}`).then(b => {
    assert.equal(b.success, true, b.error);
    return b;
  });
  const latest = await get(`/api/fund-xray?cik=${f.cik}&accession=${f.filings[0].accession}`);

  assert.equal(returns.summary.periodCount, 4);
  assert.ok(returns.positions.length > 0);
  for (const p of returns.positions) {
    for (const k of ['invested', 'realized', 'currentValue'])
      assert.ok(finite(p[k]) && p[k] >= -1e-6, `${p.title}: ${k} = ${p[k]}`);
    if (!p.lotsUnavailable) {
      assert.ok(p.moic === null || (finite(p.moic) && p.moic >= 0), `${p.title}: moic ${p.moic}`);
      assert.ok(p.irr === null || finite(p.irr), `${p.title}: irr`);
    }
    // every lot must be well-formed and chronological
    const dates = p.lots.map(l => l.date);
    assert.deepEqual([...dates].sort(), dates, `${p.title}: lots in date order`);
  }
  // Unrealized value of open positions can never exceed the latest private book.
  const open = returns.positions.filter(p => p.status === 'open').reduce((s, p) => s + p.currentValue, 0);
  assert.ok(
    open <= latest.xray.privateValueUSD * (1 + 1e-9) + 1,
    `open value ${open} ≤ private book ${latest.xray.privateValueUSD}`
  );
  // Summary = sum of usable positions.
  const usable = returns.positions.filter(p => !p.lotsUnavailable && p.invested > 0);
  assert.ok(
    close(
      returns.summary.invested,
      usable.reduce((s, p) => s + p.invested, 0),
      1
    )
  );
  assert.ok(
    close(
      returns.summary.realized,
      returns.summary.partialSales + returns.summary.leftPrivateBook,
      Math.max(1, returns.summary.realized * 1e-9)
    ),
    'realized = partial sales + left-book'
  );
});

test('LIVE private credit: finds BDC holders of a real private company and parses marks', T, async () => {
  const search = await get('/api/search-10q?issuer=' + encodeURIComponent('West Star Aviation') + '&maxPerFund=2');
  assert.ok(search.bdcFunds.length >= 1, 'at least one BDC holds it');
  const filing = search.filings.find(x => x.confirmed);
  assert.ok(filing, 'at least one confirmed filing');
  const body = await get(
    `/api/parse-10q?cik=${filing.cik}&accession=${filing.accession}&issuer=${encodeURIComponent('West Star Aviation')}&reportDate=${filing.period}`
  );
  assert.equal(body.success, true, body.error);
  assert.ok(body.holdings.length >= 1, 'schedule of investments rows found');
  for (const h of body.holdings) {
    assert.ok(finite(h.fairValue), 'fair value parsed');
    if (h.fairValueMark != null)
      assert.ok(h.fairValueMark > 0 && h.fairValueMark < 200, `mark ${h.fairValueMark}% plausible`);
    assert.match(h.portfolioCompany, /West Star/i);
  }
});

// ── front to back: real UI → real backend → real SEC ────────────────────────

function bridge() {
  return async url => {
    const res = await request(app).get(url);
    return { ok: res.status < 400, status: res.status, json: async () => res.body };
  };
}
const wait = (window, ms) => new Promise(r => window.setTimeout(r, ms));
async function until(window, cond, ms = 150000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await wait(window, 250);
  }
  return false;
}

test('LIVE UI Single Security: search → results → filter → CSV, all consistent', T, async () => {
  const { window, document } = await loadApp({ fetchImpl: bridge() });
  let csv;
  window.downloadBlob = (content, type, name) => (csv = { content, name });
  document.getElementById('filingLimit').value = '25';
  document.getElementById('securityInput').value = 'Databricks';
  await window.searchNPORT();

  const box = document.getElementById('msgBox');
  assert.ok(!box.querySelector('.alert-error'), 'no error banner: ' + box.textContent);
  const cards = document.querySelectorAll('.fund-card');
  assert.ok(cards.length >= 3, `expected multiple funds, got ${cards.length}`);
  assert.ok(window.Chart.instances.length >= 1, 'chart built');
  assert.ok(
    !/NaN|undefined|\[object Object\]/.test(document.getElementById('resultsContainer').textContent),
    'no NaN/undefined/[object Object] on screen'
  );

  const rows = document.querySelectorAll('tr[data-company]').length;
  window.doExportCSV();
  assert.equal(csv.content.split('\n').length - 1, rows, 'CSV has exactly one line per visible row');

  document.getElementById('startDate').value = '2099-01-01';
  window.applyDateFilter();
  assert.match(box.textContent, /0 data point\(s\) visible/);
  window.doExportCSV();
  assert.equal(csv.content.split('\n').length, 1, 'filtered-out rows are not exported');
});

test('LIVE UI Fund X-Ray: search → snapshot → capital structure → mark-implied returns', T, async () => {
  const { window, document } = await loadApp({ fetchImpl: bridge() });
  document.getElementById('xrayFundInput').value = 'SMALLCAP World Fund';
  await window.searchFundXray();
  assert.ok(
    await until(
      window,
      () => /Private Equity Exposure/i.test(document.getElementById('resultsContainer').textContent),
      90000
    ),
    'snapshot rendered'
  );

  const text = document.getElementById('resultsContainer').textContent;
  assert.ok(!/NaN|undefined|\[object Object\]/.test(text), 'no NaN/undefined on screen');
  assert.ok(document.querySelectorAll('#resultsContainer table').length >= 2);

  await window.runXrayReturns();
  assert.ok(
    await until(
      window,
      () => /MARK-IMPLIED MOIC/i.test(document.getElementById('xrayReturnsResult').textContent),
      180000
    ),
    'returns rendered: ' + document.getElementById('xrayReturnsResult').textContent.slice(0, 200)
  );
  const out = document.getElementById('xrayReturnsResult').textContent;
  assert.match(out, /proxies built from the fund/);
  assert.ok(!/NaN|Infinity|undefined/.test(out), 'no NaN/Infinity in returns');
});

test('LIVE UI Fund X-Ray comparison: QoQ view renders reconciled totals', T, async () => {
  const { window, document } = await loadApp({ fetchImpl: bridge() });
  document.getElementById('xrayFundInput').value = 'SMALLCAP World Fund';
  await window.searchFundXray();
  assert.ok(
    await until(
      window,
      () => /Private Equity Exposure/i.test(document.getElementById('resultsContainer').textContent),
      90000
    )
  );
  await window.selectXrayComparison('qoq');
  assert.ok(await until(window, () => !!document.getElementById('xrayCompareResults'), 90000), 'comparison rendered');
  const text = document.getElementById('xrayCompareResults').textContent;
  assert.match(text, /What Drove The Change/);
  assert.ok(!/NaN|undefined/.test(text));
});

function close(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}
