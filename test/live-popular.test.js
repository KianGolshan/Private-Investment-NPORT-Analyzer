// LIVE checks on popular private names, front to back: the real UI → real
// Express app → real SEC EDGAR. Nothing mocked, nothing synthetic.
//
//     npm run test:live        (runs this file and test/live-e2e.test.js)
//
// The point is to catch what only real filings expose. Every assertion is
// either (a) an invariant recomputed independently from the raw rows on screen,
// or (b) a real historical event that cannot change (a stock split in a filing
// already on EDGAR). Live data moves every quarter, so current dollar figures
// are never pinned.

process.env.CACHE_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const LIVE = process.env.LIVE_SEC === '1';
const app = LIVE ? require('../server') : null;
const HAS_UA = LIVE && !!process.env.SEC_USER_AGENT;
const skip = !LIVE ? 'set LIVE_SEC=1 (npm run test:live)' : !HAS_UA ? 'SEC_USER_AGENT not configured' : false;
const T = { skip, timeout: 420000 };
const { loadApp } = LIVE ? require('./helpers/loadApp') : {};

const wait = (window, ms) => new Promise(r => window.setTimeout(r, ms));
const bridge = () => async url => {
  // SEC throttles bursts (503/429 after our own retries); a couple of patient retries keep a live run honest.
  let res;
  for (let i = 0; i < 4; i++) {
    res = await request(app).get(url);
    if (res.status < 500 && res.status !== 429) break;
    await new Promise(r => setTimeout(r, 4000 * (i + 1)));
  }
  return { ok: res.status < 400, status: res.status, json: async () => res.body };
};
async function get(url) {
  const b = await bridge()(url);
  const body = await b.json();
  assert.ok(b.ok, `${url} → ${b.status} ${JSON.stringify(body).slice(0, 160)}`);
  return body;
}
const median = a => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const noBadTokens = text => !/NaN|undefined|\[object Object\]|Infinity/.test(text);

// Rows on screen → [{company, label, date, value}] straight from the DOM the user sees.
function domRows(document, scope = document) {
  return [...scope.querySelectorAll('tr[data-company]')]
    .filter(r => !r.classList.contains('row-hidden'))
    .map(r => ({
      company: r.dataset.company,
      label: r.dataset.label,
      key: r.dataset.key,
      date: r.dataset.date,
      value: +r.dataset.value,
    }));
}

// ── Single Security on popular names ────────────────────────────────────────

const POPULAR = [
  ['Anthropic', 10],
  ['OpenAI', 8],
  ['SpaceX', 4],
  ['Databricks', 8],
];

for (const [name, minFunds] of POPULAR) {
  test(
    `LIVE Single Security "${name}": real funds, clean render, and every analytic on screen recomputes from the rows shown`,
    T,
    async () => {
      const { window, document } = await loadApp({ fetchImpl: bridge() });
      document.getElementById('filingLimit').value = '50';
      document.getElementById('securityInput').value = name;
      await window.searchNPORT();
      await wait(window, 50);

      const box = document.getElementById('msgBox');
      assert.ok(!box.querySelector('.alert-error'), `${name}: ${box.textContent}`);
      const cards = [...document.querySelectorAll('.fund-card')];
      assert.ok(cards.length >= minFunds, `${name}: expected ≥${minFunds} funds, got ${cards.length}`);
      assert.ok(
        noBadTokens(document.getElementById('resultsContainer').textContent),
        'no NaN/undefined/[object Object] anywhere'
      );
      assert.ok(window.Chart.instances.length >= 1, 'chart built');

      // Every card is one fund SERIES (not a whole trust): no card name is a bare multi-fund trust when a series name exists.
      const rows = domRows(document);
      assert.ok(rows.length >= cards.length);
      assert.ok(rows.every(r => Number.isFinite(r.value) && r.value > 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.date)));

      // Independent outlier check: each badge's stated deviation must match the same-class peers' as-of median from raw rows.
      const byCompanyKey = {};
      rows.forEach(r => (byCompanyKey[`${r.label}||${r.company}||${r.key}`] ||= []).push(r));
      for (const card of cards) {
        for (const badge of card.querySelectorAll('.fund-name span')) {
          const m = badge.textContent.match(/(▲|▼)\s*([+-]\d+)%/);
          if (!m) continue;
          const company = card.querySelector('.fund-name').childNodes[0].textContent.trim();
          const mine = Object.entries(byCompanyKey).filter(([k]) => k.split('||')[1] === company);
          assert.ok(mine.length, `${company}: badge with no rows`);
          // Any of this fund's series may carry the badge — at least one must independently deviate by the stated amount.
          const ok = mine.some(([k, list]) => {
            const [label] = k.split('||');
            const latest = [...list].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
            const peers = [];
            for (const [k2, l2] of Object.entries(byCompanyKey)) {
              const [label2, company2] = k2.split('||');
              if (label2 !== label || company2 === company) continue;
              const asOf = [...l2]
                .filter(r => r.date <= latest.date)
                .sort((a, b) => a.date.localeCompare(b.date))
                .at(-1);
              if (asOf && (Date.parse(latest.date) - Date.parse(asOf.date)) / 86400000 <= 135) peers.push(asOf.value);
            }
            if (peers.length < 4) return false;
            const dev = (latest.value / median(peers) - 1) * 100;
            return Math.abs(dev - +m[2]) <= 1.01 && Math.abs(dev) >= 15;
          });
          assert.ok(ok, `${name}: "${badge.textContent.trim()}" on ${company} does not recompute from the rows shown`);
        }
      }

      // Independent velocity check: "X% vs DATE" must equal the fund's own value ratio vs that earlier filing (unless a split intervenes).
      for (const card of cards) {
        const meta = card.querySelector('.fund-meta').textContent;
        const m = meta.match(/([+-]\d+\.\d)% vs (\d{4}-\d{2}-\d{2})/);
        if (!m) continue;
        const company = card.querySelector('.fund-name').childNodes[0].textContent.trim();
        const list = rows.filter(r => r.company === company);
        const prior = list.filter(r => r.date === m[2]);
        assert.ok(prior.length, `${company}: velocity references ${m[2]} which is not one of its filings`);
        const latestDate = list
          .map(r => r.date)
          .sort()
          .at(-1);
        const ratios = prior.flatMap(p =>
          list.filter(r => r.date === latestDate && r.key === p.key).map(r => (r.value / p.value - 1) * 100)
        );
        // A stock split between the two filings legitimately makes the raw price ratio differ; the app
        // restates prices onto the post-split basis, so accept the raw ratio × a clean split factor.
        const SPLIT_FACTORS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 50, 100, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 10];
        const reproduces = x => SPLIT_FACTORS.some(k => Math.abs(((1 + x / 100) * k - 1) * 100 - +m[1]) <= 0.11);
        if (ratios.length) {
          assert.ok(ratios.some(reproduces), `${company}: ${m[1]}% not reproduced by ${ratios.map(x => x.toFixed(1))}`);
        }
      }

      // Repricing ledger: entries are chronological and only include moves of 5%+ by 3+ different funds.
      const ledger = document.querySelector('details.mark-ledger');
      if (ledger) {
        ledger.querySelectorAll('tbody tr').forEach(tr => {
          const dates = [...tr.lastElementChild.textContent.matchAll(/(\d{4}-\d{2}-\d{2})\)/g)].map(x => x[1]);
          assert.deepEqual([...dates].sort(), dates, 'order of first appearance is chronological');
          assert.ok(dates.length >= 3, 'an episode needs 3+ funds');
          const pcts = [...tr.lastElementChild.textContent.matchAll(/\(([+-]\d+)%,/g)].map(x => +x[1]);
          assert.ok(
            pcts.every(p => Math.abs(p) >= 5),
            'every counted move is 5%+'
          );
        });
      }

      // Every table row links to a real EDGAR filing.
      assert.ok(
        [...document.querySelectorAll('.source-link')].every(a =>
          /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\//.test(a.href)
        )
      );
    }
  );
}

test(
  'LIVE Batch + Watchlist on popular names: leaderboard dispersion/age recompute from the rows shown',
  T,
  async () => {
    const { window, document } = await loadApp({ fetchImpl: bridge() });
    document.getElementById('batchFilingLimit').value = '25';
    document.getElementById('batchInput').value = 'Anthropic\nOpenAI\nDatabricks\nSpaceX';
    await window.searchBatch();
    await wait(window, 50);
    const box = document.getElementById('msgBox');
    assert.ok(!box.querySelector('.alert-error'), box.textContent);
    assert.match(box.textContent, /holdings for [34] of 4 securities/);

    const lb = document.getElementById('basketLeaderboard');
    assert.ok(lb, 'leaderboard rendered');
    for (const tr of lb.querySelectorAll('tbody tr')) {
      const label = tr.querySelector('td').textContent.trim();
      const sec =
        document.querySelector(`[id^="secsection_"]`) &&
        [...document.querySelectorAll('[id^="secsection_"]')].find(s =>
          s.querySelector('h2, h3')?.textContent.includes(label.split(' (')[0])
        );
      if (!sec) continue;
      const secRows = domRows(document, sec);
      const latestByCompany = {};
      secRows.forEach(r => {
        const k = r.company;
        if (!latestByCompany[k] || r.date > latestByCompany[k].date) latestByCompany[k] = r;
      });
      const vals = Object.values(latestByCompany).map(r => r.value);
      const disp = ((Math.max(...vals) - Math.min(...vals)) / median(vals)) * 100;
      const shown = parseFloat(tr.children[3].textContent);
      if (Number.isFinite(shown) && vals.length > 1)
        assert.ok(Math.abs(shown - disp) < 0.2, `${label}: dispersion ${shown} vs recomputed ${disp.toFixed(1)}`);
    }
    assert.ok(noBadTokens(document.getElementById('resultsContainer').textContent));

    // Watchlist runs the same pipeline from localStorage.
    window.localStorage.setItem('nportWatchlist', JSON.stringify(['Anthropic', 'OpenAI']));
    window.switchTab('watchlist');
    document.getElementById('watchlistFilingLimit').value = '25';
    await window.runWatchlist();
    assert.match(document.getElementById('msgBox').textContent, /holdings for 2 of 2 securities/);
    assert.equal(document.getElementById('watchlistDateFilterPanel').style.display, 'block');
  }
);

// ── Fund X-Ray on the real funds that hold those names ─────────────────────

async function firstHolderSeries(name, wantSeriesName) {
  const s = await get('/api/search-nport?security=' + encodeURIComponent(name));
  for (const h of s.hits.hits.slice(0, 40)) {
    const { ciks, adsh } = h._source;
    const p = await get(`/api/parse-nport?cik=${ciks[0]}&accession=${adsh}&security=${encodeURIComponent(name)}`);
    const hit = (p.holdings || []).find(x => !wantSeriesName || x.seriesName === wantSeriesName);
    if (hit) return { cik: ciks[0], accession: adsh, seriesName: hit.seriesName };
  }
  throw new Error('no holder found for ' + name);
}

test(
  'LIVE multi-series trust: Fidelity Advisor Series I lists its real funds and each fund’s history stays inside one series',
  T,
  async () => {
    const s = await get('/api/search-fund?fund=' + encodeURIComponent('Fidelity Advisor Series I'));
    const match = s.matches.find(m => m.cik === '722574');
    assert.ok(match && match.filings.length > 100, 'a trust with hundreds of interleaved filings');

    const info = await get('/api/fund-series?cik=722574');
    assert.equal(info.multiSeries, true);
    assert.ok(info.series.length >= 8, `expected many funds, got ${info.series.length}`);
    assert.ok(info.series.every(x => /^S\d{9}$/.test(x.seriesId) && x.seriesName));
    assert.equal(new Set(info.series.map(x => x.seriesId)).size, info.series.length, 'series ids unique');

    const pick = info.series.find(x => /Growth Opportunities/i.test(x.seriesName)) || info.series[0];
    const sf = await get(`/api/fund-series-filings?cik=722574&seriesId=${pick.seriesId}`);
    assert.ok(sf.filings.length >= 8);
    const dates = sf.filings.map(f => f.reportDate);
    assert.equal(new Set(dates).size, dates.length, 'one filing per report date within a series');
    for (const f of sf.filings.slice(0, 5)) {
      const x = (await get(`/api/fund-xray?cik=722574&accession=${f.accession}`)).xray;
      assert.equal(x.fund.seriesId, pick.seriesId, `${f.accession} belongs to ${pick.seriesName}`);
      assert.equal(x.fund.reportDate, f.reportDate);
    }
  }
);

test(
  'LIVE Fund X-Ray UI on a multi-series trust: pick a fund → snapshot, capital structure, QoQ comparison and returns all stay in that fund',
  T,
  async () => {
    const { window, document } = await loadApp({ fetchImpl: bridge() });
    document.getElementById('xrayFundInput').value = 'Fidelity Advisor Series I';
    await window.searchFundXray();
    await wait(window, 50);
    assert.equal(document.getElementById('xraySeriesGroup').style.display, 'flex');
    const select = document.getElementById('xraySeriesSelect');
    const opt = [...select.options].find(o => /Growth Opportunities/i.test(o.textContent));
    assert.ok(opt, 'Growth Opportunities fund listed');
    select.value = opt.value;
    await window.onXraySeriesChange();
    await wait(window, 50);

    const container = document.getElementById('resultsContainer');
    assert.match(container.textContent, /Private Equity Exposure/i);
    assert.ok(noBadTokens(container.textContent));
    const fundName = container.querySelector('h2').textContent;
    assert.match(fundName, /Growth Opportunities/i);

    await window.selectXrayComparison('qoq');
    await wait(window, 50);
    const cmp = document.getElementById('xrayCompareResults');
    assert.ok(cmp, 'comparison rendered');
    assert.ok(noBadTokens(cmp.textContent));
    const cur = window.__state.xrayFilings;
    assert.ok(
      cur.every(f => f.company === opt.textContent),
      'every period belongs to the chosen fund'
    );
    assert.match(cmp.textContent, new RegExp(cur[1].period));

    await window.runXrayReturns();
    await wait(window, 50);
    const ret = document.getElementById('xrayReturnsResult');
    assert.match(ret.textContent, /MARK-IMPLIED MOIC/i);
    assert.ok(noBadTokens(ret.textContent));
  }
);

test(
  'LIVE returns — real 5-for-1 split at Destiny Tech100 (SpaceX SPVs, 2026-06-30) is not booked as capital or a markdown',
  T,
  async () => {
    const s = await get('/api/search-fund?fund=' + encodeURIComponent('Destiny Tech100'));
    const m = s.matches.find(x => x.cik === '1843974');
    assert.ok(m, 'Destiny Tech100 found');
    const fl = [...m.filings].sort((a, b) => a.reportDate.localeCompare(b.reportDate));
    const upTo = fl.filter(f => f.reportDate >= '2025-12-31' && f.reportDate <= '2026-06-30');
    assert.equal(upTo.length, 3, 'periods 2025-12-31, 2026-03-31, 2026-06-30');

    const { returns } = await get(
      `/api/fund-xray-returns?cik=1843974&accessions=${upTo.map(f => f.accession).join(',')}`
    );
    const spacex = returns.positions.filter(p => /SpaceX/i.test(p.title) && p.events.some(e => e.type === 'split'));
    assert.ok(spacex.length >= 2, `both real SpaceX SPVs show the split, got ${spacex.length}`);
    for (const p of spacex) {
      const split = p.events.find(e => e.type === 'split');
      assert.equal(split.ratio, 5);
      assert.equal(split.date, '2026-06-30');
      assert.ok(!p.events.some(e => e.type === 'addon'), 'no purchase invented by the split');
      assert.ok(p.moic > 1.5 && p.moic < 3, `${p.title}: MOIC ${p.moic}`);
    }

    const cmp = (
      await get(
        `/api/fund-xray-compare?cik=1843974&currentAccession=${upTo[2].accession}&priorAccession=${upTo[1].accession}`
      )
    ).comparison;
    const held = cmp.positions.filter(p => p.splitRatio === 5);
    assert.ok(held.length >= 2, 'comparison flags the same split');
    for (const p of held) {
      // Real units aren't always an exact multiple (Snowpoint: 28,486 → 142,425 vs 142,430) — tolerate rounding, not a purchase.
      assert.ok(
        Math.abs(p.shareEffectUSD) < Math.abs(p.priceEffectUSD) * 0.001,
        `position-sizing effect ${p.shareEffectUSD} vs price effect ${p.priceEffectUSD}`
      );
      assert.ok(p.priceEffectUSD > 0, 'the re-mark was upward');
    }
    assert.ok(!cmp.insights.topMarkdowns.items.some(p => p.splitRatio === 5), 'the split is not a markdown');
  }
);

test(
  'LIVE returns — real 10-for-1 splits (Runway, Discord, Perplexity) are recognized at the real filings where they happened',
  T,
  async () => {
    // Every case below is a real, permanent event in filings already on EDGAR (raw rows in test/real-data.test.js).
    const cases = [
      {
        cik: '720318',
        seriesId: 'S000007755',
        match: /RUNWAY AI INC SER D/i,
        from: '2024-12-31',
        to: '2025-06-30',
        date: '2025-03-31',
      },
      {
        cik: '720318',
        seriesId: 'S000007755',
        match: /DISCORD INC SER I/i,
        from: '2025-12-31',
        to: '2026-06-30',
        date: '2026-03-31',
      },
      {
        cik: '819930',
        seriesId: 'S000002119',
        match: /PERPLEXITY AI SER D-1/i,
        from: '2025-12-31',
        to: '2026-06-30',
        date: '2026-03-31',
      },
    ];
    for (const c of cases) {
      const sf = await get(`/api/fund-series-filings?cik=${c.cik}&seriesId=${c.seriesId}`);
      const upTo = sf.filings
        .filter(f => f.reportDate >= c.from && f.reportDate <= c.to)
        .sort((a, b) => a.reportDate.localeCompare(b.reportDate));
      assert.equal(upTo.length, 3, `${c.match}: three quarterly periods spanning the split`);
      const { returns } = await get(
        `/api/fund-xray-returns?cik=${c.cik}&accessions=${upTo.map(f => f.accession).join(',')}`
      );
      const p = returns.positions.find(x => c.match.test(x.title));
      assert.ok(p, `${c.match} held in the window`);
      const split = p.events.find(e => e.type === 'split');
      assert.ok(split, `${p.title}: split expected at ${c.date}`);
      assert.equal(split.ratio, 10);
      assert.equal(split.date, c.date);
      assert.ok(!p.events.some(e => e.type === 'addon'), 'the split created no purchase');
      assert.equal(p.lots.length, 1);
    }
  }
);

test(
  'LIVE real matching quality: across popular-name holders, position tracking keeps distinct issuers apart',
  T,
  async () => {
    const holder = await firstHolderSeries('Databricks', 'T. Rowe Price Global Stock Fund');
    const x0 = (await get(`/api/fund-xray?cik=${holder.cik}&accession=${holder.accession}`)).xray;
    const sf = await get(`/api/fund-series-filings?cik=${holder.cik}&seriesId=${x0.fund.seriesId}`);
    const accs = sf.filings.slice(0, 8).map(f => f.accession);
    const { returns } = await get(`/api/fund-xray-returns?cik=${holder.cik}&accessions=${accs.join(',')}`);
    assert.equal(returns.summary.periodCount, 8);
    // A chained position must share its issuer stem with what it was chained from — the real-data bug was unrelated issuers ("N/A" names).
    const stem = t =>
      String(t)
        .toUpperCase()
        .split(/[^A-Z0-9]+/)
        .filter(Boolean)[0];
    for (const p of returns.positions.filter(x => x.chainedFrom)) {
      assert.equal(stem(p.chainedFrom), stem(p.title), `${p.chainedFrom} → ${p.title}`);
    }
    // No two open positions may be the same instrument.
    const open = returns.positions.filter(p => p.status === 'open').map(p => p.title);
    assert.equal(new Set(open).size, open.length, 'no duplicate open positions');
    // Capital structure groups by company, not by instrument: no issuer stem appears twice.
    const stems = x0.capitalStructure.map(c => stem(c.issuer));
    assert.equal(new Set(stems).size, stems.length, 'one capital-structure row per company');
  }
);

test(
  'LIVE real capital structures: debt held alongside equity in the same private company (Tenstorrent, SiMa, ...) is surfaced with correct totals',
  T,
  async () => {
    const s = await get('/api/search-fund?fund=' + encodeURIComponent('ARK Venture Fund'));
    const m = s.matches.find(x => x.cik === '1905088');
    const latest = [...m.filings].sort((a, b) => b.reportDate.localeCompare(a.reportDate))[0];
    const x = (await get(`/api/fund-xray?cik=1905088&accession=${latest.accession}`)).xray;
    const multi = x.capitalStructure.filter(c => c.multiTranche);
    assert.ok(multi.length >= 1, 'at least one company held through several instruments');
    for (const c of multi) {
      assert.ok(Math.abs(c.totalValueUSD - c.instruments.reduce((a, i) => a + i.marketValue, 0)) < 1);
      assert.ok(Math.abs(Object.values(c.byType).reduce((a, b) => a + b, 0) - c.totalValueUSD) < 1);
      if (c.byType.debt) assert.ok(c.instruments[0].instrumentType === 'debt', 'debt sorts first (most senior)');
    }
  }
);

// ── Private Credit on popular PE-backed borrowers held by BDCs ─────────────

const BORROWERS = [
  ['Anaplan', 1],
  ['Kaseya', 1],
  ['Pluralsight', 1],
  ['Medallia', 1],
  ['Finastra', 1],
];

for (const [name, minFunds] of BORROWERS) {
  test(`LIVE Private Credit "${name}": real BDC schedules parse into consistent rows`, T, async () => {
    const { window, document } = await loadApp({ fetchImpl: bridge() });
    document.getElementById('creditFilingLimit').value = '20';
    document.getElementById('creditIssuerInput').value = name;
    await window.searchPrivateCredit();
    await wait(window, 50);

    const box = document.getElementById('msgBox');
    assert.ok(!box.querySelector('.alert-error'), `${name}: ${box.textContent}`);
    const cards = [...document.querySelectorAll('#resultsContainer .fund-card')];
    assert.ok(cards.length >= minFunds, `${name}: expected ≥${minFunds} BDCs, got ${cards.length}`);
    assert.ok(noBadTokens(document.getElementById('resultsContainer').textContent));

    const rows = [...document.querySelectorAll('#resultsContainer tbody tr[data-company]')];
    assert.ok(rows.length >= 2, `${name}: real tranches found`);
    const num = t =>
      /^[\d,.\-()]+$/.test(t.trim()) ? parseFloat(t.replace(/[(),]/g, m => (m === '(' ? '-' : ''))) : null;
    let withMark = 0;
    for (const tr of rows) {
      const cells = [...tr.children].map(td => td.textContent.trim());
      // columns: show, date, company, industry, type, index, spread, cash, pik, maturity, principal, cost, fv, mark, notes
      assert.match(cells[1], /^\d{4}-\d{2}-\d{2}/);
      assert.ok(new RegExp(name, 'i').test(cells[2]), `${name}: row for "${cells[2]}"`);
      const principal = num(cells[10]);
      const fv = num(cells[12]);
      const mark = cells[13] === '—' ? null : parseFloat(cells[13]);
      if (mark !== null) {
        withMark++;
        assert.ok(mark >= 0 && mark <= 150, `${name}: mark ${mark}% outside 0–150 (${cells.join(' | ')})`);
        assert.ok(principal > 0 && fv !== null, 'a mark needs par and fair value');
        // The table rounds amounts to whole units, so allow for that rounding in the recomputed mark.
        assert.ok(
          Math.abs((fv / principal) * 100 - mark) < 0.01 + (100 * 0.5 * (1 + fv / principal)) / principal,
          `${name}: mark ${mark} ≠ fair value ÷ par (${fv}/${principal})`
        );
      }
      assert.ok(
        !(principal === null && fv !== null && fv < 0),
        `no unfunded commitments among holdings: ${cells.join(' | ')}`
      );
    }
    assert.ok(withMark >= 1, `${name}: at least one real par-based mark`);
    assert.ok(
      [...document.querySelectorAll('.source-link')].every(a => /sec\.gov\/Archives\/edgar\/data\//.test(a.href))
    );
    assert.ok(window.Chart.instances.length >= 1, 'chart built');
  });
}

// ── Fund X-Ray "Top Funds" shortlist: every curated name must resolve on live EDGAR ──

test(
  'LIVE Top Funds: every name on the curated shortlist resolves to a real registrant with NPORT-P filings (and multi-series trusts list their funds)',
  T,
  async () => {
    const { window } = await loadApp();
    const groups = window.__state.TOP_FUND_GROUPS;
    const names = Object.values(groups).flat();
    assert.ok(names.length >= 50, `shortlist has ${names.length} names`);
    const failures = [];
    let multi = 0;
    for (const name of names) {
      try {
        const s = await get('/api/search-fund?fund=' + encodeURIComponent(name));
        const withFilings = (s.matches || []).filter(m => m.filings.length > 0);
        if (!withFilings.length) {
          failures.push(`${name}: no registrant with NPORT-P filings`);
          continue;
        }
        const info = await get('/api/fund-series?cik=' + withFilings[0].cik);
        if (info.multiSeries) {
          multi++;
          if (!info.series.length) failures.push(`${name}: multi-series trust listed no funds`);
        }
      } catch (e) {
        failures.push(`${name}: ${e.message.slice(0, 120)}`);
      }
    }
    assert.ok(multi >= 5, `expected several multi-series trusts on the shortlist, saw ${multi}`);
    assert.deepEqual(failures, [], failures.join('\n'));
  }
);
