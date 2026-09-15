// Top-level functions invoked only from inline onclick/onkeydown/oninput
// handlers in index.html and in the HTML strings this file generates
// (render*/toggle*/apply*/clear*/do*Export* below) — ESLint can't see those
// string-embedded call sites, so this tells no-unused-vars they're used.
/* exported searchBatch, runWatchlist, toggleFund, selectAllRows, onCheckboxChange,
   applyClassFilter, toggleClassChip, applyReference, clearReference, applyDateFilter,
   clearDateFilter, applyBatchDateFilter, clearBatchDateFilter, doExportCSV,
   doExportExcel, doExportPDF, applyCreditDateFilter, clearCreditDateFilter,
   applyCreditReference, clearCreditReference, doCreditExportCSV, doCreditExportExcel,
   addWatchlistItem, removeWatchlistItem, quickAddToWatchlist, openAbout,
   searchFundXray, runFundXray, doXrayExportCSV, selectXrayComparison,
   onXrayCompareSelectChange, runFundXrayCompare, doXrayCompareExportCSV, selectIndexedFund */

// ── State ──────────────────────────────────────────────────────────────────
let allResults = {};
let singleCharts = {}; // { instrumentType: Chart } — one per bucket shown on Single Security
let batchCharts = {}; // { canvasId: Chart }
let allCreditResults = {};
let creditChart = null;
let singleReferenceValue = null; // optional user-entered $ price to overlay/diff against peers (equity bucket only)
let creditReferenceValue = null; // optional user-entered mark (%) to overlay/diff against peers
let xrayFilings = []; // filings returned by the current Fund X-Ray search, sorted newest-first
let xraySnapshots = { current: null, prior: null }; // { xray, filing } per rendered period-detail section, for CSV export/re-render
let currentXrayCompare = null; // most recently rendered QoQ/YoY comparison, for CSV export
let xrayCompareMode = null; // 'qoq' | 'yoy' | null — re-resolved when Current Period changes; null for a manual pick or no comparison
let fundIndex = []; // pre-built "Top Funds" shortlist from /api/fund-index (see scripts/build-fund-index.js)

const WATCHLIST_KEY = 'nportWatchlist';

// ── Instrument-type metadata ────────────────────────────────────────────────
// A single search can return economically incomparable holdings (equity,
// debt, warrants, indirect/SPV exposure) — see parsers.js classifyInstrument
// for the real-filing evidence. Each type gets its own chart/table section
// with the axis and formatting that actually makes sense for it, instead of
// forcing everything onto one $/share line.
const INSTRUMENT_META = {
  equity: {
    sectionTitle: 'Equity',
    unitNoun: 'Price',
    chartTitle: 'Price Per Share Over Time',
    axisLabel: 'Price Per Share',
    valueLabel: 'Price / Share',
    fmt: fmtCurrency,
    tickFmt: v => '$' + v.toFixed(2),
    showMarketValueColumn: true, // distinct from the per-share value
  },
  debt: {
    sectionTitle: 'Debt / Loans',
    unitNoun: 'Mark',
    chartTitle: 'Mark (% of Par) Over Time',
    axisLabel: 'Mark (% of Par)',
    valueLabel: 'Mark (%)',
    fmt: v => v.toFixed(2) + '%',
    tickFmt: v => v.toFixed(1) + '%',
    showMarketValueColumn: true, // distinct from the % mark
  },
  derivative: {
    sectionTitle: 'Derivatives (Warrants/Options)',
    unitNoun: 'Value',
    chartTitle: 'Value Per Unit Over Time',
    axisLabel: 'Value Per Unit ($)',
    // Per-unit (valUSD / balance), same convention as every other type —
    // NOT total position value. A per-warrant price can be a tiny fraction
    // of a cent early in a warrant's life and a normal-looking number
    // later (real Kandou case: ~$0.0000001 in 2023 -> $0.01 by 2026);
    // total value would also conflate "the mark moved" with "the fund
    // bought/sold units," which per-unit avoids.
    valueLabel: 'Value / Unit',
    fmt: fmtCurrency,
    tickFmt: v => '$' + v.toFixed(2),
    showMarketValueColumn: true, // now genuinely distinct from the per-unit value
  },
  indirect: {
    sectionTitle: 'Indirect / Fund Exposure',
    unitNoun: 'Value',
    chartTitle: 'Value Per Unit Over Time',
    axisLabel: 'Value Per Unit ($)',
    valueLabel: 'Value / Unit',
    fmt: fmtCurrency,
    tickFmt: v => '$' + v.toFixed(2),
    showMarketValueColumn: true, // same rationale as derivative above
  },
};
const INSTRUMENT_ORDER = ['equity', 'debt', 'derivative', 'indirect'];

// Canvas id for one bucket's chart. Equity always keeps the caller's own
// base id (e.g. "singleChart", unchanged from before this feature existed)
// so every equity-only-target function (reference overlay, PDF export)
// keeps working without special-casing; other buckets get a suffixed id.
function bucketCanvasId(baseId, type) {
  return type === 'equity' ? baseId : `${baseId}_${type}`;
}
function nonEmptyBuckets(buckets) {
  return INSTRUMENT_ORDER.filter(t => buckets[t] && Object.keys(buckets[t]).length > 0);
}
// Distinct fund count across all buckets (a fund holding e.g. both equity
// and debt in the same company should still count once).
function countDistinctFunds(buckets) {
  const funds = new Set();
  Object.values(buckets).forEach(map => Object.keys(map).forEach(c => funds.add(c)));
  return funds.size;
}

// ── 15-color palette so charts look good with many funds ──────────────────
// A coordinated navy/slate/gold set (matching the app's visual system)
// rather than a bright default chart-library rainbow.
const COLORS = [
  '#0f2440',
  '#b8860b',
  '#0f766e',
  '#7f1d1d',
  '#3b5170',
  '#6b7a3a',
  '#5b3a6b',
  '#8a5a2b',
  '#1e3a5f',
  '#a16207',
  '#2f4858',
  '#844b2b',
  '#4c6b53',
  '#5c4a72',
  '#7a6a3a',
];
const getColor = i => COLORS[i % COLORS.length];

// ── Init: check server config ──────────────────────────────────────────────
(async () => {
  try {
    const cfg = await fetchJSON('/api/config');
    if (!cfg.userAgentConfigured) {
      document.getElementById('configWarning').style.display = 'block';
    }
  } catch (_) {}
  renderWatchlist();
  loadFundIndex();
  applyURLParams();
})();

// ── Fund X-Ray: "Top Funds" pre-built shortlist ─────────────────────────────
// Populates the quick-select dropdown from the pre-built index (see
// scripts/build-fund-index.js) so a well-known fund can be pulled into Fund
// X-Ray with one click instead of typing a name and resolving it live via
// /api/search-fund.
async function loadFundIndex() {
  const select = document.getElementById('xrayTopFundsSelect');
  try {
    const data = await fetchJSON('/api/fund-index');
    fundIndex = data.funds || [];
    if (!fundIndex.length) throw new Error('empty index');
    select.innerHTML =
      '<option value="">— Pick a fund —</option>' +
      fundIndex
        .map(
          f =>
            `<option value="${esc(f.cik)}">${esc(f.name)} — ${fmtCompactCurrency(f.privateValueUSD)} PE (${(f.privatePctOfNetAssets ?? 0).toFixed(1)}% NAV)</option>`
        )
        .join('');
  } catch (_) {
    select.innerHTML = '<option value="">Unavailable — run `npm run build-fund-index`</option>';
    document.getElementById('xrayTopFundsHint').textContent =
      'Top Funds shortlist not built yet — see the README for how to generate it. You can still search any fund by name below.';
  }
}

// Pulls a fund straight from the pre-built index into Fund X-Ray, bypassing
// /api/search-fund entirely — the index already carries this fund's CIK and
// its full trailing-3-year filing list, so there's no name to resolve and no
// ambiguity to disambiguate.
async function selectIndexedFund(cik) {
  if (!cik) return;
  const entry = fundIndex.find(f => String(f.cik) === String(cik));
  if (!entry) return;

  clearResults();
  document.getElementById('xrayFundInput').value = entry.name;

  const filings = entry.filings.map(f => ({
    cik: String(entry.cik),
    accession: f.accession,
    company: entry.name,
    period: f.reportDate || f.filingDate || '',
    fileDate: f.filingDate || '',
  }));
  filings.sort((a, b) => dateCmp(b.period || b.fileDate, a.period || a.fileDate));

  xrayFilings = filings;
  xrayCompareMode = null;
  currentXrayCompare = null;
  document.getElementById('xraySelectorPanel').style.display = 'block';
  const optionsHTML = filings
    .map((f, i) => `<option value="${i}">${esc(f.period || f.fileDate)} — ${esc(f.company)}</option>`)
    .join('');
  document.getElementById('xrayFilingSelect').innerHTML = optionsHTML;
  document.getElementById('xrayCompareSelect').innerHTML = '<option value="">— No comparison —</option>' + optionsHTML;
  document.getElementById('xrayCompareResults')?.remove();

  await runFundXray();
}

// ── Shareable / pre-fillable URL ────────────────────────────────────────────
// ?security=Anthropic&limit=50            -> Single Security tab, auto-run
// ?tab=credit&issuer=West+Star&limit=40   -> Private Credit tab, auto-run
// After a successful search the address bar is updated to match (via
// history.replaceState, no reload), so the current view is always a
// copy-pasteable link without any extra step.
function applyURLParams() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  const limit = params.get('limit');
  const issuer = params.get('issuer');
  const security = params.get('security');

  if (tab === 'credit' && issuer) {
    switchTab('credit', { skipUrlReset: true });
    document.getElementById('creditIssuerInput').value = issuer;
    if (['20', '40', '80'].includes(limit)) document.getElementById('creditFilingLimit').value = limit;
    searchPrivateCredit();
  } else if (security) {
    document.getElementById('securityInput').value = security;
    if (['25', '50', '100'].includes(limit)) document.getElementById('filingLimit').value = limit;
    searchNPORT();
  }
}
function updateURLParams(params) {
  const url = new URL(window.location.href);
  url.search = '';
  Object.entries(params).forEach(([k, v]) => {
    if (v) url.searchParams.set(k, v);
  });
  window.history.replaceState({}, '', url);
}

// ── About modal ─────────────────────────────────────────────────────────────
function openAbout() {
  document.getElementById('aboutModal').style.display = 'flex';
  document.addEventListener('keydown', handleAboutEscape);
}
function closeAbout() {
  document.getElementById('aboutModal').style.display = 'none';
  document.removeEventListener('keydown', handleAboutEscape);
}
function handleAboutEscape(e) {
  if (e.key === 'Escape') closeAbout();
}

// ── Tab management ─────────────────────────────────────────────────────────
function switchTab(tab, { skipUrlReset } = {}) {
  const tabNames = ['single', 'batch', 'credit', 'watchlist', 'xray'];
  document.querySelectorAll('.tab').forEach((el, i) => el.classList.toggle('active', tabNames[i] === tab));
  document.getElementById('singleTab').classList.toggle('active', tab === 'single');
  document.getElementById('batchTab').classList.toggle('active', tab === 'batch');
  document.getElementById('creditTab').classList.toggle('active', tab === 'credit');
  document.getElementById('watchlistTab').classList.toggle('active', tab === 'watchlist');
  document.getElementById('xrayTab').classList.toggle('active', tab === 'xray');
  clearResults();
  // Skipped when applyURLParams() is driving the tab switch on page load —
  // it still has incoming ?security=/?issuer= params to read and act on.
  if (!skipUrlReset) window.history.replaceState({}, '', window.location.pathname);
  if (tab === 'watchlist') renderWatchlist();
}

// ── Single search ──────────────────────────────────────────────────────────
async function searchNPORT() {
  const security = document.getElementById('securityInput').value.trim();
  if (!security) return showMsg('Please enter a security name or ticker.', 'error');

  clearResults();
  showLoading('Searching SEC EDGAR...');

  try {
    const data = await fetchJSON('/api/search-nport?security=' + enc(security));
    if (!data.hits?.hits?.length) {
      hideLoading();
      return showMsg('No NPORT-P filings found. Try a different name or ticker.', 'error');
    }

    const limit = +document.getElementById('filingLimit').value;
    const filings = sortFilings(data.hits.hits.slice(0, limit));
    const { holdings, failures } = await parseFilings(filings, security);

    hideLoading();
    hideProgress();

    if (!holdings.length) {
      return showMsg(
        `No holdings found for "${security}" in these filings.` +
          (failures.length ? ` (${failures.length} filing(s) failed to fetch/parse and may be missing data.)` : ''),
        'error'
      );
    }

    const buckets = groupAndDedupe(holdings);
    allResults = { mode: 'single', single: buckets };

    const funds = countDistinctFunds(buckets);
    showMsg(
      `Found ${holdings.length} holding(s) across ${funds} fund(s).` +
        (failures.length
          ? ` ${failures.length} filing(s) failed to parse and were skipped — data may be incomplete.`
          : ''),
      failures.length ? 'warning' : 'success'
    );
    document.getElementById('dateFilterPanel').style.display = 'block';
    document.getElementById('referencePanel').style.display =
      buckets.equity && Object.keys(buckets.equity).length ? 'block' : 'none';
    updateURLParams({ security, limit });
    renderSingleResults(buckets);
  } catch (err) {
    hideLoading();
    hideProgress();
    showMsg('Error: ' + err.message, 'error');
  }
}

// ── Batch search ───────────────────────────────────────────────────────────
async function searchBatch() {
  const raw = document.getElementById('batchInput').value.trim();
  if (!raw) return showMsg('Please enter at least one security.', 'error');

  const securities = raw
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  if (!securities.length) return showMsg('Please enter at least one security.', 'error');
  if (securities.length > 10) return showMsg('Maximum 10 securities allowed.', 'error');

  const limit = +document.getElementById('batchFilingLimit').value;
  await runBatchPipeline(securities, limit);
}

// ── Watchlist "run all" — same pipeline, no 10-issuer cap ─────────────────
async function runWatchlist() {
  const securities = getWatchlist();
  if (!securities.length) return showMsg('Your watchlist is empty — add some issuers first.', 'error');

  const limit = +document.getElementById('watchlistFilingLimit').value;
  await runBatchPipeline(securities, limit);
}

// ── Shared batch pipeline (used by both Batch Search and Watchlist) ───────
async function runBatchPipeline(securities, limit) {
  clearResults();
  showLoading(`Starting search across ${securities.length} issuer(s)...`);

  const batchResults = {};
  let totalFailures = 0;

  for (let i = 0; i < securities.length; i++) {
    const security = securities[i];
    showProgress(`Searching ${i + 1}/${securities.length}: ${security}`, (i / securities.length) * 100);

    try {
      const data = await fetchJSON('/api/search-nport?security=' + enc(security));
      if (!data.hits?.hits?.length) continue;

      const filings = sortFilings(data.hits.hits.slice(0, limit));
      const { holdings, failures } = await parseFilings(filings, security);
      totalFailures += failures.length;
      if (holdings.length) {
        batchResults[security] = groupAndDedupe(holdings);
      }
    } catch (err) {
      console.error('Batch error for', security, err);
    }
  }

  hideLoading();
  hideProgress();

  if (!Object.keys(batchResults).length) {
    return showMsg(
      'No holdings found for any of the securities.' +
        (totalFailures ? ` (${totalFailures} filing(s) failed to fetch/parse.)` : ''),
      'error'
    );
  }

  const found = Object.keys(batchResults).length;
  showMsg(
    `Found holdings for ${found} of ${securities.length} securities.` +
      (totalFailures
        ? ` ${totalFailures} filing(s) failed to parse across all searches — data may be incomplete.`
        : ''),
    totalFailures ? 'warning' : 'success'
  );
  document.getElementById('batchDateFilterPanel').style.display = 'block';
  allResults = { mode: 'batch', batch: batchResults };
  renderBatchResults(batchResults);
}

// ── Parse filings (parallel batches of 5) ─────────────────────────────────
// Returns { holdings, failures } — failures are filings that errored or the
// server couldn't fetch/parse, distinct from filings that simply had no
// matching holdings (both used to be silently collapsed to []).
async function parseFilings(filings, security) {
  const all = [];
  const failures = [];
  const batchSize = 5;

  for (let i = 0; i < filings.length; i += batchSize) {
    showProgress(
      `Parsing filings ${i + 1}–${Math.min(i + batchSize, filings.length)} of ${filings.length}…`,
      (i / filings.length) * 100
    );

    const batch = filings.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async filing => {
        const src = filing._source;
        const cik = src.ciks?.[0];
        const accession = src.adsh;
        const company = src.display_names?.[0] || 'Unknown Fund';
        if (!cik || !accession) {
          failures.push({ company, reason: 'missing CIK/accession' });
          return [];
        }
        try {
          const url = `/api/parse-nport?cik=${cik}&accession=${enc(accession)}&security=${enc(security)}`;
          const parsed = await fetchJSON(url);
          if (!parsed.success) {
            failures.push({ company, reason: parsed.error || 'Unknown error' });
            return [];
          }
          return (parsed.holdings || []).map(h => ({ ...h, company, cik, accession }));
        } catch (err) {
          failures.push({ company, reason: err.message });
          return [];
        }
      })
    );

    results.forEach(r => all.push(...r));
    if (i + batchSize < filings.length) await sleep(250);
  }

  return { holdings: all, failures };
}

// ── Group by instrument type, then by company, deduplicate ─────────────────
// Returns { equity: {company: holdings[]}, debt: {...}, derivative: {...},
// indirect: {...} } — bucketed by instrument type first (see INSTRUMENT_META)
// so economically incomparable holdings never end up on the same chart
// axis, then grouped by company same as before within each bucket.
function groupAndDedupe(holdings) {
  const buckets = { equity: {}, debt: {}, derivative: {}, indirect: {} };

  holdings.forEach(h => {
    const type = buckets[h.instrumentType] ? h.instrumentType : 'equity'; // safety net, should not trigger
    if (!buckets[type][h.company]) buckets[type][h.company] = [];
    buckets[type][h.company].push(h);
  });

  Object.values(buckets).forEach(map => {
    Object.keys(map).forEach(company => {
      map[company].sort((a, b) => dateCmp(a.reportDate, b.reportDate));
      const seen = new Set();
      map[company] = map[company].filter(h => {
        // instrumentKey (identifiers.other.value, falling back to CUSIP/
        // title) is a stronger dedupe key than title/name alone — it's
        // still unique per instrument even when two different classes
        // share identical, uninformative title text.
        const key = `${h.reportDate}_${h.shares}_${h.instrumentKey}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
  });

  return buckets;
}

// Splits one company's holdings into per-instrument series, computing a
// disambiguated label so same-fund holdings that collide on the same
// fallback label (e.g. two rows both generically "Preferred", per the real
// BlackRock case found in the Databricks survey) are still visually
// distinguishable even though instrumentKey already keeps them as separate
// data series.
function groupCompanyByInstrumentKey(company, holdings) {
  const byKey = {};
  holdings.forEach(h => {
    const k = h.instrumentKey || company;
    (byKey[k] ||= []).push(h);
  });
  const keys = Object.keys(byKey);
  const multi = keys.length > 1;

  const labelCounts = {};
  keys.forEach(k => {
    const lbl = byKey[k][0].instrumentLabel || '';
    labelCounts[lbl] = (labelCounts[lbl] || 0) + 1;
  });

  return keys.map(k => {
    const hs = byKey[k].slice().sort((a, b) => dateCmp(a.reportDate, b.reportDate));
    const baseLabel = hs[0].instrumentLabel || '';
    const collision = multi && labelCounts[baseLabel] > 1;
    const shortLabel = collision ? `${baseLabel} (…${String(k).slice(-6)})` : baseLabel;
    const fullLabel = multi ? `${company} — ${shortLabel}` : company;
    // baseLabel (pre-disambiguation) is what chips/filtering group by —
    // the disambiguation suffix exists so two colliding rows are tellable
    // apart *within one fund's table*, not to fragment the section-wide
    // "toggle everything in this class" control into one chip per
    // collision (real case: ~15 funds each with one unlabeled "Common"
    // row produced ~15 near-duplicate chips before this fix).
    return { company, key: k, baseLabel, shortLabel, fullLabel, holdings: hs };
  });
}

// Flat list of (company, instrumentKey) series across an entire bucket —
// what the chart actually plots one line per.
function getSeriesGroups(companiesMap) {
  return Object.keys(companiesMap).flatMap(company => groupCompanyByInstrumentKey(company, companiesMap[company]));
}

// ── Compute summary stats ─────────────────────────────────────────────────
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function computeStats(companiesMap) {
  const all = Object.values(companiesMap).flat();
  if (!all.length) return null;

  const values = all.map(h => h.chartValue).filter(v => v != null && v > 0);
  const dates = all
    .map(h => h.reportDate)
    .filter(Boolean)
    .sort();
  const sorted = [...all].sort((a, b) => dateCmp(b.reportDate, a.reportDate));

  return {
    latestValue: sorted[0]?.chartValue ?? 0,
    latestDate: sorted[0]?.reportDate ?? '',
    minValue: values.length ? Math.min(...values) : 0,
    maxValue: values.length ? Math.max(...values) : 0,
    medianValue: median(values),
    fundCount: Object.keys(companiesMap).length,
    dataPoints: all.length,
    firstDate: dates[0] || '',
    lastDate: dates[dates.length - 1] || '',
  };
}

// ── Reference/benchmark divergence stat box (shared shape for $ and %) ────
function referenceStatBoxHTML(referenceValue, peerMedian, fmt, unitLabel) {
  if (referenceValue == null || !peerMedian) return '';
  const diffPct = ((referenceValue - peerMedian) / peerMedian) * 100;
  const sign = diffPct > 0 ? '+' : '';
  const color = diffPct > 0 ? 'var(--green)' : diffPct < 0 ? 'var(--red)' : 'var(--gray-900)';
  return `
    <div class="stat-box">
      <div class="stat-label">Reference vs Peer Median</div>
      <div class="stat-value" style="color:${color}">${sign}${diffPct.toFixed(1)}%</div>
      <div class="stat-sub">Ref: ${fmt(referenceValue)} · Median: ${fmt(peerMedian)}${unitLabel || ''}</div>
    </div>`;
}

function statsHTML(stats, referenceValue, meta) {
  if (!stats) return '';
  meta = meta || INSTRUMENT_META.equity;
  const fmt = meta.fmt;
  return `
    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-label">Latest ${esc(meta.unitNoun)}</div>
        <div class="stat-value highlight">${fmt(stats.latestValue)}</div>
        <div class="stat-sub">${stats.latestDate || '—'}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">${esc(meta.unitNoun)} Range</div>
        <div class="stat-value sm">${fmt(stats.minValue)} – ${fmt(stats.maxValue)}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Reporting Funds</div>
        <div class="stat-value">${stats.fundCount}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Data Points</div>
        <div class="stat-value">${stats.dataPoints}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Date Range</div>
        <div class="stat-value sm">${stats.firstDate}<br>${stats.lastDate}</div>
      </div>
      ${referenceValue != null ? referenceStatBoxHTML(referenceValue, stats.medianValue, fmt) : ''}
    </div>`;
}

// ── Render: one instrument-type section (stats + chart + table) ───────────
// Shared by Single Security and Batch Search. In the common case (one
// instrument type present) this renders with no visible section header or
// wrapper styling beyond what already existed — visually identical to
// before this feature. Only when 2+ types are present for the same search
// does the section header/border show, to explain why the results are
// split.
function renderInstrumentSectionHTML(companiesMap, type, canvasBaseId, tablePrefix, showHeader, opts) {
  opts = opts || {};
  const meta = INSTRUMENT_META[type];
  const stats = computeStats(companiesMap);
  const canvasId = bucketCanvasId(canvasBaseId, type);
  const referenceValue = type === 'equity' && opts.allowReference ? singleReferenceValue : null;
  const statsGridId = opts.statsGridId || '';

  let html = `<div class="instrument-section" data-bucket="${type}">`;
  if (showHeader) {
    html += `<h3 class="instrument-section-title">${esc(meta.sectionTitle)}</h3>`;
  }
  html += `<div${statsGridId ? ` id="${statsGridId}"` : ''}>${statsHTML(stats, referenceValue, meta)}</div>`;

  // Wide-range safety valve: if this bucket's values span a huge ratio,
  // say so rather than silently rendering a chart where most lines
  // flatline near zero against one outlier (verified real cases going both
  // ways — Databricks stayed in a tight $150-$237 band across 35 filers,
  // Kandou's classes would have spanned $0.0000001-$0.25 if not already
  // split by instrument type).
  if (stats && stats.minValue > 0 && stats.maxValue / stats.minValue > 20) {
    html += `<div class="alert alert-warning" style="margin-bottom:14px;">Wide ${meta.unitNoun.toLowerCase()} range in this view (${meta.fmt(stats.minValue)} – ${meta.fmt(stats.maxValue)}) — check for mismatched classes.</div>`;
  }

  // Class chips + free-text filter, shown whenever this bucket actually has
  // more than one distinct class label to tell apart (not equity-only —
  // debt/derivative can have multiple tranches too). Chips are a one-click
  // toggle for exact labels actually present; the text field stays for
  // fuzzy cross-convention matches ("G" also catching "G-1").
  const distinctLabels = [...new Set(getSeriesGroups(companiesMap).map(g => g.baseLabel))].sort();
  if (distinctLabels.length > 1) {
    const filterId = `classFilter_${tablePrefix}`;
    html +=
      `<div class="class-chips" data-prefix="${tablePrefix}">` +
      distinctLabels
        .map(l => `<button type="button" class="chip active" onclick="toggleClassChip(this)">${esc(l)}</button>`)
        .join('') +
      `</div>`;
    html += `
      <div class="search-row" style="margin-bottom:14px;">
        <div class="input-group narrow">
          <label for="${filterId}">Filter by Class</label>
          <input type="text" id="${filterId}" placeholder="e.g., G" oninput="applyClassFilter(this)">
        </div>
      </div>
      <div class="hint" style="margin-top:-8px; margin-bottom:14px;">Click a chip to toggle one class everywhere in this section, or type to fuzzy-match across naming conventions (e.g. "G" also catches "G-1") — without assuming different filers' labels mean exactly the same thing.</div>`;
  }

  // Default chart height scales with how many lines will actually be drawn
  // — a fixed height meant for 3-4 funds visibly crushes both the plot area
  // and the legend once a search returns 15+ funds/classes (real case:
  // "Anthropic" across 18 funds). The expand button covers the rest.
  const seriesCount = getSeriesGroups(companiesMap).length;
  const chartHeight = Math.min(640, 320 + Math.max(0, seriesCount - 5) * 16);

  html += `<div class="chart-panel">
    <div class="chart-panel-header">
      <h3>${esc(meta.chartTitle)}</h3>
      <button type="button" class="btn btn-sm btn-secondary chart-expand-btn" onclick="toggleChartExpand(this)">Expand</button>
    </div>
    <div class="chart-canvas-wrap" style="height:${chartHeight}px;"><canvas id="${canvasId}"></canvas></div>
  </div>`;
  html += '<div class="results-header"><h2>Holdings by Fund</h2></div>';
  html += renderFundCards(companiesMap, tablePrefix, type);
  html += '</div>';
  return html;
}

// ── Render: single results ─────────────────────────────────────────────────
function renderSingleResults(buckets) {
  const types = nonEmptyBuckets(buckets);
  const multi = types.length > 1;

  let html = '<div class="results-section">';
  if (multi) {
    const names = types.map(t => INSTRUMENT_META[t].sectionTitle.toLowerCase()).join(', ');
    html += `<div class="alert alert-info">Holdings span ${esc(names)} — shown in separate sections below since they aren't directly comparable on one chart.</div>`;
  }

  types.forEach(type => {
    html += renderInstrumentSectionHTML(buckets[type], type, 'singleChart', 'single_' + type, multi, {
      allowReference: type === 'equity',
      statsGridId: type === 'equity' ? 'statsGrid' : '',
    });
  });

  html += `<div class="export-row">
    <button class="btn btn-green" onclick="doExportCSV()">Export CSV</button>
    <button class="btn btn-green" onclick="doExportExcel()">Export Excel</button>
    <button class="btn btn-red"   onclick="doExportPDF()">Export PDF</button>
  </div>`;
  html += '</div>';

  document.getElementById('resultsContainer').innerHTML = html;
  types.forEach(type => buildChart(bucketCanvasId('singleChart', type), buckets[type], type, true));
}

// ── Render: batch results ──────────────────────────────────────────────────
function renderBatchResults(batchResults) {
  let html = '';

  Object.keys(batchResults).forEach(security => {
    const buckets = batchResults[security];
    const types = nonEmptyBuckets(buckets);
    const multi = types.length > 1;
    const secId = cleanId(security);

    html += `<div class="security-section" id="secsection_${secId}">`;
    html += `<div class="security-section-header">${esc(security)}</div>`;
    if (multi) {
      const names = types.map(t => INSTRUMENT_META[t].sectionTitle.toLowerCase()).join(', ');
      html += `<div class="alert alert-info">Holdings span ${esc(names)} — shown in separate sections below since they aren't directly comparable on one chart.</div>`;
    }
    types.forEach(type => {
      html += renderInstrumentSectionHTML(buckets[type], type, 'chart_' + secId, secId + '_' + type, multi, {});
    });
    html += `</div>`;
  });

  html += `<div class="export-row">
    <button class="btn btn-green" onclick="doExportCSV()">Export CSV (All)</button>
    <button class="btn btn-green" onclick="doExportExcel()">Export Excel (All)</button>
    <button class="btn btn-red"   onclick="doExportPDF()">Export PDF (All)</button>
  </div>`;

  document.getElementById('resultsContainer').innerHTML = html;

  Object.keys(batchResults).forEach(security => {
    const secId = cleanId(security);
    nonEmptyBuckets(batchResults[security]).forEach(type => {
      buildChart(bucketCanvasId('chart_' + secId, type), batchResults[security][type], type, false);
    });
  });
}

// ── Source-of-truth: link back to the original EDGAR filing ───────────────
function edgarFilingUrl(cik, accession) {
  if (!cik || !accession) return null;
  const cikNum = String(cik).replace(/^0+/, '');
  const accNoDash = String(accession).replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}/${accession}-index.htm`;
}
function sourceLinkHTML(cik, accession, dateLabel) {
  const url = edgarFilingUrl(cik, accession);
  const label = dateLabel || '—';
  return url
    ? `<a class="source-link" href="${url}" target="_blank" rel="noopener noreferrer" title="View source filing on EDGAR">${label} ↗</a>`
    : label;
}

// ── Fund card HTML ─────────────────────────────────────────────────────────
function renderFundCards(companiesMap, prefix, type) {
  const meta = INSTRUMENT_META[type] || INSTRUMENT_META.equity;
  let html = '';
  let rowIndex = 0;

  Object.keys(companiesMap).forEach((company, compIdx) => {
    const wrapId = `wrap_${prefix}_${compIdx}`;
    const arrowId = `arrow_${prefix}_${compIdx}`;
    const holdings = companiesMap[company];
    const groups = groupCompanyByInstrumentKey(company, holdings);
    const latestH = [...holdings].sort((a, b) => dateCmp(b.reportDate, a.reportDate))[0];
    const latestV = latestH ? meta.fmt(latestH.chartValue) : '—';

    html += `
      <div class="fund-card">
        <div class="fund-header" onclick="toggleFund('${wrapId}','${arrowId}')">
          <div>
            <div class="fund-name">${esc(company)}</div>
            <div class="fund-meta">${holdings.length} data point(s) &bull; Latest: ${latestV}</div>
          </div>
          <div class="fund-actions">
            <button class="btn btn-sm btn-primary"   onclick="event.stopPropagation(); selectAllRows('${wrapId}', true)">All</button>
            <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); selectAllRows('${wrapId}', false)">None</button>
            <span class="toggle-arrow up" id="${arrowId}">&#9660;</span>
          </div>
        </div>
        <div class="fund-table-wrap" id="${wrapId}">
          <table>
            <thead><tr>
              <th class="center" style="width:38px">Show</th>
              <th>Report Date</th>
              <th>Class</th>
              <th>Investment Title</th>
              <th class="right">Shares</th>
              ${meta.showMarketValueColumn ? '<th class="right">Market Value</th>' : ''}
              <th class="right">${esc(meta.valueLabel)}</th>
              <th class="center">CCY</th>
            </tr></thead>
            <tbody>`;

    // Rows are ordered by instrument-key group (not raw date order across
    // the whole fund) so that a fund holding e.g. two share classes shows
    // each class's history as a contiguous block, not interleaved.
    groups.forEach(g => {
      g.holdings.forEach(h => {
        const hIdx = holdings.indexOf(h); // index into companiesMap[company] — export relies on this
        const rowId = `row_${prefix}_${rowIndex}`;
        const cbId = `cb_${prefix}_${rowIndex}`;
        html += `
          <tr id="${rowId}" data-company="${esc(company)}" data-idx="${hIdx}" data-key="${esc(g.key)}" data-label="${esc(g.baseLabel)}" data-bucket="${type}" data-date="${h.reportDate}" data-value="${h.chartValue}">
            <td class="center">
              <input type="checkbox" id="${cbId}" class="chart-checkbox" data-prefix="${prefix}" checked
                     onchange="onCheckboxChange(this)">
            </td>
            <td>${sourceLinkHTML(h.cik, h.accession, h.reportDate)}</td>
            <td>${esc(g.shortLabel)}</td>
            <td class="title-cell">${esc(h.title || h.name || '—')}</td>
            <td class="right">${fmtNum(h.shares)}</td>
            ${meta.showMarketValueColumn ? `<td class="right">${fmtCurrency(h.marketValue)}</td>` : ''}
            <td class="right price-cell">${meta.fmt(h.chartValue)}</td>
            <td class="center">${h.currency || 'USD'}</td>
          </tr>`;
        rowIndex++;
      });
    });

    html += `</tbody></table></div></div>`;
  });

  return html;
}

// ── Toggle fund table expand/collapse ──────────────────────────────────────
function toggleFund(wrapId, arrowId) {
  const wrap = document.getElementById(wrapId);
  const arrow = document.getElementById(arrowId);
  const collapsed = wrap.classList.contains('collapsed');
  wrap.classList.toggle('collapsed', !collapsed);
  arrow.classList.toggle('up', !collapsed); // up when expanded
}

// ── Select / deselect all rows in a fund ──────────────────────────────────
function selectAllRows(wrapId, checked) {
  const wrap = document.getElementById(wrapId);
  wrap.querySelectorAll('.chart-checkbox').forEach(cb => {
    cb.checked = checked;
    cb.closest('tr').classList.toggle('row-hidden', !checked);
  });
  rebuildAllCharts();
}

// ── Checkbox change ────────────────────────────────────────────────────────
function onCheckboxChange(cb) {
  cb.closest('tr').classList.toggle('row-hidden', !cb.checked);
  rebuildAllCharts();
}

// ── Build chart ────────────────────────────────────────────────────────────
function buildChart(canvasId, companiesMap, type, isSingle) {
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  const meta = INSTRUMENT_META[type] || INSTRUMENT_META.equity;

  const chart = new Chart(ctx, {
    type: 'line',
    data: { datasets: buildDatasets(companiesMap) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 14, font: { size: 11 } } },
        tooltip: {
          callbacks: { label: c => `${c.dataset.label}: ${meta.fmt(c.parsed.y)}` },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'month' },
          title: { display: true, text: 'Report Date' },
        },
        y: {
          title: { display: true, text: meta.axisLabel },
          ticks: { callback: meta.tickFmt },
        },
      },
    },
  });

  if (isSingle) {
    singleCharts[type] = chart;
  } else {
    batchCharts[canvasId] = chart;
  }
}

function buildDatasets(companiesMap) {
  return getSeriesGroups(companiesMap).map((g, i) => ({
    label: g.fullLabel.substring(0, 60),
    data: g.holdings.filter(h => h.reportDate).map(h => ({ x: h.reportDate, y: h.chartValue })),
    borderColor: getColor(i),
    backgroundColor: getColor(i) + '22',
    pointRadius: 4,
    pointHoverRadius: 6,
    tension: 0.35,
  }));
}

// ── Rebuild charts from checkbox state ────────────────────────────────────
function rebuildAllCharts() {
  if (allResults.mode === 'single') {
    Object.entries(allResults.single || {}).forEach(([type, map]) => {
      if (!Object.keys(map).length) return;
      const id = bucketCanvasId('singleChart', type);
      rebuildChart(id, singleCharts[type], map, type);
    });
  } else if (allResults.mode === 'batch') {
    Object.entries(allResults.batch || {}).forEach(([security, buckets]) => {
      const baseId = 'chart_' + cleanId(security);
      Object.entries(buckets).forEach(([type, map]) => {
        if (!Object.keys(map).length) return;
        const id = bucketCanvasId(baseId, type);
        rebuildChart(id, batchCharts[id], map, type);
      });
    });
  }
}

function rebuildChart(canvasId, chart, companiesMap, type) {
  if (!chart) return;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  // Scope row lookups to the containing section AND bucket, so a security
  // with multiple instrument-type sections (each its own table) doesn't
  // cross-contaminate, and batch charts stay independent per security.
  const section = canvas.closest('.security-section') || canvas.closest('.results-section') || document;
  const allRows = Array.from(section.querySelectorAll(`tr[data-bucket="${type}"]`));

  const datasets = getSeriesGroups(companiesMap)
    .map((g, i) => {
      const data = [];
      allRows.forEach(row => {
        if (row.dataset.company === g.company && row.dataset.key === g.key) {
          const cb = row.querySelector('.chart-checkbox');
          if (cb?.checked) {
            data.push({ x: row.dataset.date, y: parseFloat(row.dataset.value) });
          }
        }
      });
      return {
        label: g.fullLabel.substring(0, 60),
        data,
        borderColor: getColor(i),
        backgroundColor: getColor(i) + '22',
        pointRadius: 4,
        tension: 0.35,
      };
    })
    .filter(d => d.data.length > 0);

  if (type === 'equity' && singleReferenceValue != null) {
    const refDs = buildReferenceLineDataset(datasets, singleReferenceValue, 'Reference Price');
    if (refDs) datasets.push(refDs);
  }

  chart.data.datasets = datasets;
  chart.update();
}

// ── Class quick-filter ─────────────────────────────────────────────────────
// Word-boundary-matches each row's parsed class label (not the raw title)
// and toggles the same checkboxes the date filter uses — lets an analyst
// isolate e.g. "Series G" across every fund shown in one section without
// the tool asserting that different filers' labels mean the same thing.
// Word-boundary (not plain substring) matters here: labels are always
// "{Common|Preferred|Class} {code}", and a plain substring match on a
// single-letter query like "D" would also match "Preferre[d]" itself.
function applyClassFilter(inputEl) {
  const section = inputEl.closest('.instrument-section');
  if (!section) return;
  const q = inputEl.value.trim();
  const re = q ? new RegExp('\\b' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  section.querySelectorAll('tr[data-company]').forEach(row => {
    const label = row.dataset.label || '';
    const match = !re || re.test(label);
    const cb = row.querySelector('.chart-checkbox');
    if (cb) cb.checked = match;
    row.classList.toggle('row-hidden', !match);
  });
  // Typing a query overrides whatever the chips show — keep them in sync
  // rather than leaving stale "active" chips that no longer match reality.
  section.querySelectorAll('.class-chips .chip').forEach(chip => {
    chip.classList.toggle('active', !re || re.test(chip.textContent));
  });
  rebuildAllCharts();
}

// One-click toggle for a single exact class label across an entire section
// (every fund at once) — the "easier, more discoverable" complement to
// typing into the filter box above. Multiple chips can be active at once.
function toggleClassChip(btn) {
  btn.classList.toggle('active');
  const section = btn.closest('.instrument-section');
  if (!section) return;
  const activeLabels = new Set([...section.querySelectorAll('.class-chips .chip.active')].map(b => b.textContent));
  section.querySelectorAll('tr[data-company]').forEach(row => {
    const match = activeLabels.has(row.dataset.label);
    const cb = row.querySelector('.chart-checkbox');
    if (cb) cb.checked = match;
    row.classList.toggle('row-hidden', !match);
  });
  rebuildAllCharts();
}

// ── Chart expand/collapse ───────────────────────────────────────────────────
// Toggles one chart into a large fixed overlay — the default height scales
// with series count already, but a search with many funds/classes (e.g.
// 18+ for a popular name) can still outgrow any fixed size. Uses
// Chart.getChart() to find the right instance regardless of which state
// map (singleCharts/batchCharts/creditChart) it lives in.
function toggleChartExpand(btn) {
  const panel = btn.closest('.chart-panel');
  const wrap = panel?.querySelector('.chart-canvas-wrap');
  const canvas = wrap?.querySelector('canvas');
  if (!wrap || !canvas) return;

  const expanding = !wrap.classList.contains('expanded');
  wrap.classList.toggle('expanded', expanding);
  btn.innerHTML = expanding ? 'Close' : 'Expand';
  // The button lives in .chart-panel-header, a normal-flow sibling of the
  // now position:fixed wrap — without this it scrolls out from under the
  // overlay and becomes invisible/unclickable, leaving only Escape or a
  // backdrop click to close (found live: the button was there in the DOM
  // but not actually visible once expanded).
  btn.style.cssText = expanding ? 'position:fixed; top:calc(5vh + 12px); right:calc(5vw + 12px); z-index:1002;' : '';
  // Stashed so the module-level Escape handler (a stable function reference,
  // needed so add/removeEventListener actually match) can find its way back
  // to the right button without closing over a stale one.
  wrap._expandBtn = expanding ? btn : null;

  let backdrop = document.getElementById('chartBackdrop');
  if (expanding) {
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'chartBackdrop';
      backdrop.className = 'chart-backdrop';
      document.body.appendChild(backdrop);
    }
    backdrop.onclick = () => toggleChartExpand(btn);
    document.addEventListener('keydown', handleChartExpandEscape);
  } else {
    backdrop?.remove();
    document.removeEventListener('keydown', handleChartExpandEscape);
  }

  // Chart.js's own ResizeObserver usually catches this, but the abrupt
  // position:fixed jump doesn't always fire it reliably — nudge explicitly.
  setTimeout(() => Chart.getChart(canvas)?.resize(), 50);
}
function handleChartExpandEscape(e) {
  if (e.key !== 'Escape') return;
  const wrap = document.querySelector('.chart-canvas-wrap.expanded');
  if (wrap?._expandBtn) toggleChartExpand(wrap._expandBtn);
}

// ── Reference/benchmark line: a flat dashed line spanning the plotted range ─
function buildReferenceLineDataset(datasets, value, label) {
  const allX = datasets
    .flatMap(d => d.data.map(p => p.x))
    .filter(Boolean)
    .sort();
  if (!allX.length) return null;
  return {
    label,
    data: [
      { x: allX[0], y: value },
      { x: allX[allX.length - 1], y: value },
    ],
    borderColor: '#0f2440',
    borderDash: [8, 4],
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 0,
    fill: false,
    tension: 0,
  };
}

// ── Reference/benchmark price (Single Security tab) ────────────────────────
function applyReference() {
  const raw = document.getElementById('referencePrice').value.trim();
  const value = parseFloat(raw);
  if (!raw || isNaN(value) || value <= 0) {
    return showMsg('Enter a valid positive reference price.', 'error');
  }
  singleReferenceValue = value;
  refreshSingleView();
}
function clearReference() {
  singleReferenceValue = null;
  setVal('referencePrice', '');
  refreshSingleView();
}
function refreshSingleView() {
  const equityMap = allResults.single?.equity;
  if (!equityMap || !Object.keys(equityMap).length) return;
  const statsEl = document.getElementById('statsGrid');
  if (statsEl) statsEl.innerHTML = statsHTML(computeStats(equityMap), singleReferenceValue, INSTRUMENT_META.equity);
  rebuildChart('singleChart', singleCharts.equity, equityMap, 'equity');
}

// ── Date filters ───────────────────────────────────────────────────────────
function applyDateFilter() {
  filterByDate(val('startDate'), val('endDate'));
}
function clearDateFilter() {
  setVal('startDate', '');
  setVal('endDate', '');
  filterByDate('', '');
}
function applyBatchDateFilter() {
  filterByDate(val('batchStartDate'), val('batchEndDate'));
}
function clearBatchDateFilter() {
  setVal('batchStartDate', '');
  setVal('batchEndDate', '');
  filterByDate('', '');
}

function filterByDate(start, end) {
  const startTs = start ? new Date(start).getTime() : 0;
  const endTs = end ? new Date(end).getTime() : Infinity;
  let count = 0;

  document.querySelectorAll('.chart-checkbox').forEach(cb => {
    const row = cb.closest('tr');
    const ts = new Date(row.dataset.date || '').getTime();
    const inRange = ts >= startTs && ts <= endTs;
    cb.checked = inRange;
    row.classList.toggle('row-hidden', !inRange);
    if (inRange) count++;
  });

  rebuildAllCharts();
  showMsg(`Filter applied: ${count} data point(s) visible.`, 'success');
}

// ── Collect only checked/visible rows (respects checkboxes + date filter) ──
// Exports must reflect what's actually on screen, not the raw unfiltered
// result set — otherwise unchecking rows or applying a date filter has no
// effect on what gets exported.
function collectVisible(companiesMap, container) {
  const result = {};
  if (!container) return companiesMap; // fallback: nothing rendered, export everything
  container.querySelectorAll('tr[data-company]').forEach(row => {
    const cb = row.querySelector('.chart-checkbox');
    if (!cb || !cb.checked) return;
    const company = row.dataset.company;
    const idx = +row.dataset.idx;
    const h = companiesMap[company]?.[idx];
    if (!h) return;
    if (!result[company]) result[company] = [];
    result[company].push(h);
  });
  return result;
}

// Bucket-aware: each instrument-type section has its own scoped container
// (data-bucket) so a company appearing in multiple buckets (or two
// securities sharing a company name, in batch mode) can't cross-contaminate
// via data-idx collisions.
function visibleSingleBuckets() {
  const out = {};
  Object.keys(allResults.single || {}).forEach(type => {
    const container = document.querySelector(`.results-section .instrument-section[data-bucket="${type}"]`);
    out[type] = collectVisible(allResults.single[type], container);
  });
  return out;
}
function visibleBatchBuckets() {
  const out = {};
  Object.entries(allResults.batch || {}).forEach(([sec, buckets]) => {
    out[sec] = {};
    Object.keys(buckets).forEach(type => {
      const container = document.querySelector(
        `#secsection_${cleanId(sec)} .instrument-section[data-bucket="${type}"]`
      );
      out[sec][type] = collectVisible(buckets[type], container);
    });
  });
  return out;
}

// Flattens one bucket's companiesMap into export-ready rows, each carrying
// its instrument Type/Class alongside the existing fields.
function flattenBucketRows(type, companiesMap, security) {
  const meta = INSTRUMENT_META[type] || INSTRUMENT_META.equity;
  const rows = [];
  Object.entries(companiesMap).forEach(([co, hs]) => {
    groupCompanyByInstrumentKey(co, hs).forEach(g => {
      g.holdings.forEach(h =>
        rows.push({
          security,
          type: meta.sectionTitle,
          cls: g.shortLabel,
          company: co,
          reportDate: h.reportDate,
          title: h.title || '',
          shares: h.shares,
          marketValue: h.marketValue,
          value: h.chartValue,
          currency: h.currency || 'USD',
          url: edgarFilingUrl(h.cik, h.accession) || '',
        })
      );
    });
  });
  return rows;
}

// ── Export: CSV ────────────────────────────────────────────────────────────
function doExportCSV() {
  const isSingle = allResults.mode === 'single';
  const header = isSingle
    ? [
        'Type',
        'Class',
        'Fund',
        'Report Date',
        'Title',
        'Shares',
        'Market Value (USD)',
        'Value',
        'Currency',
        'Source Filing URL',
      ]
    : [
        'Security',
        'Type',
        'Class',
        'Fund',
        'Report Date',
        'Title',
        'Shares',
        'Market Value (USD)',
        'Value',
        'Currency',
        'Source Filing URL',
      ];
  const rows = [header];

  const pushRows = list =>
    list.forEach(r =>
      rows.push(
        (isSingle ? [] : [r.security]).concat([
          r.type,
          r.cls,
          r.company,
          r.reportDate,
          r.title,
          r.shares,
          r.marketValue,
          r.value.toFixed(4),
          r.currency,
          r.url,
        ])
      )
    );

  if (isSingle) {
    Object.entries(visibleSingleBuckets()).forEach(([type, map]) => pushRows(flattenBucketRows(type, map)));
  } else {
    Object.entries(visibleBatchBuckets()).forEach(([sec, buckets]) =>
      Object.entries(buckets).forEach(([type, map]) => pushRows(flattenBucketRows(type, map, sec)))
    );
  }

  const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
  downloadBlob(csv, 'text/csv', `nport_${allResults.mode}_${today()}.csv`);
}

// ── Export: Excel ──────────────────────────────────────────────────────────
function doExportExcel() {
  const wb = XLSX.utils.book_new();
  const bucketCols = [
    { wch: 20 },
    { wch: 20 },
    { wch: 42 },
    { wch: 12 },
    { wch: 42 },
    { wch: 14 },
    { wch: 18 },
    { wch: 14 },
    { wch: 10 },
    { wch: 50 },
  ];

  if (allResults.mode === 'single') {
    // One sheet per instrument type present (Equity/Debt/Derivatives/
    // Indirect) — mirrors the per-security sheet pattern batch mode uses.
    Object.entries(visibleSingleBuckets()).forEach(([type, map]) => {
      const rows = flattenBucketRows(type, map);
      if (!rows.length) return;
      const data = [
        [
          'Type',
          'Class',
          'Fund',
          'Report Date',
          'Title',
          'Shares',
          'Market Value (USD)',
          'Value',
          'Currency',
          'Source Filing URL',
        ],
      ];
      rows.forEach(r =>
        data.push([
          r.type,
          r.cls,
          r.company,
          r.reportDate,
          r.title,
          r.shares,
          r.marketValue,
          r.value,
          r.currency,
          r.url,
        ])
      );
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws['!cols'] = bucketCols;
      XLSX.utils.book_append_sheet(wb, ws, INSTRUMENT_META[type].sectionTitle.substring(0, 31));
    });
  } else {
    const visibleBatch = visibleBatchBuckets();
    const combined = [
      [
        'Security',
        'Type',
        'Class',
        'Fund',
        'Report Date',
        'Title',
        'Shares',
        'Market Value (USD)',
        'Value',
        'Currency',
        'Source Filing URL',
      ],
    ];

    Object.entries(visibleBatch).forEach(([sec, buckets]) => {
      const allRows = Object.keys(buckets).flatMap(type => flattenBucketRows(type, buckets[type], sec));
      if (!allRows.length) return;
      const data = [
        [
          'Type',
          'Class',
          'Fund',
          'Report Date',
          'Title',
          'Shares',
          'Market Value (USD)',
          'Value',
          'Currency',
          'Source Filing URL',
        ],
      ];
      allRows.forEach(r => {
        data.push([
          r.type,
          r.cls,
          r.company,
          r.reportDate,
          r.title,
          r.shares,
          r.marketValue,
          r.value,
          r.currency,
          r.url,
        ]);
        combined.push([
          sec,
          r.type,
          r.cls,
          r.company,
          r.reportDate,
          r.title,
          r.shares,
          r.marketValue,
          r.value,
          r.currency,
          r.url,
        ]);
      });
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws['!cols'] = bucketCols;
      XLSX.utils.book_append_sheet(wb, ws, sec.substring(0, 31));
    });

    const ws2 = XLSX.utils.aoa_to_sheet(combined);
    ws2['!cols'] = [{ wch: 14 }, ...bucketCols];
    XLSX.utils.book_append_sheet(wb, ws2, 'All Holdings');
  }

  XLSX.writeFile(wb, `nport_${allResults.mode}_${today()}.xlsx`);
}

// ── Export: PDF ────────────────────────────────────────────────────────────
function doExportPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape' });
  const margin = 14;
  const pageW = doc.internal.pageSize.width;

  // Page header
  const writePageHeader = (title, yStart) => {
    let y = yStart;
    doc.setFontSize(16);
    doc.setFont(undefined, 'bold');
    doc.setTextColor(37, 99, 235);
    doc.text(title, margin, y);
    y += 7;
    doc.setFontSize(8.5);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(100);
    doc.text('Generated: ' + new Date().toLocaleString(), margin, y);
    y += 8;
    doc.setTextColor(0);
    return y;
  };

  // Draw one section: chart image + autotable
  const drawSection = (companiesMap, title, chartId, type, yStart) => {
    let y = writePageHeader(title, yStart);
    const meta = INSTRUMENT_META[type] || INSTRUMENT_META.equity;

    const canvas = chartId ? document.getElementById(chartId) : null;
    if (canvas) {
      const imgH = 68;
      const imgW = pageW - margin * 2;
      doc.addImage(canvas.toDataURL('image/png'), 'PNG', margin, y, imgW, imgH);
      y += imgH + 6;
    }

    const rows = [];
    Object.entries(companiesMap).forEach(([co, hs]) =>
      groupCompanyByInstrumentKey(co, hs).forEach(g =>
        g.holdings.forEach(h =>
          rows.push([
            co.substring(0, 30),
            g.shortLabel.substring(0, 20),
            h.reportDate || '',
            (h.title || h.name || '').substring(0, 30),
            fmtNum(h.shares),
            fmtCurrency(h.marketValue),
            meta.fmt(h.chartValue),
            h.currency || 'USD',
          ])
        )
      )
    );

    if (rows.length) {
      doc.autoTable({
        startY: y,
        head: [['Fund', 'Class', 'Date', 'Title', 'Shares', 'Mkt Value', meta.valueLabel, 'CCY']],
        body: rows,
        margin: { left: margin, right: margin },
        styles: { fontSize: 7.5, cellPadding: 2.5 },
        headStyles: { fillColor: [37, 99, 235], fontStyle: 'bold', fontSize: 8 },
        columnStyles: {
          0: { cellWidth: 46 },
          1: { cellWidth: 34 },
          2: { cellWidth: 20 },
          3: { cellWidth: 46 },
          4: { cellWidth: 22, halign: 'right' },
          5: { cellWidth: 24, halign: 'right' },
          6: { cellWidth: 24, halign: 'right' },
          7: { cellWidth: 14, halign: 'center' },
        },
        alternateRowStyles: { fillColor: [249, 250, 251] },
      });
    }
  };

  if (allResults.mode === 'single') {
    const buckets = visibleSingleBuckets();
    nonEmptyBuckets(buckets).forEach((type, i) => {
      if (i > 0) doc.addPage();
      const canvasId = bucketCanvasId('singleChart', type);
      drawSection(
        buckets[type],
        `SEC NPORT-P Holdings Analysis — ${INSTRUMENT_META[type].sectionTitle}`,
        canvasId,
        type,
        margin
      );
    });
  } else {
    const visibleBatch = visibleBatchBuckets();
    let firstPage = true;
    Object.keys(allResults.batch).forEach(security => {
      const secId = cleanId(security);
      const buckets = visibleBatch[security] || {};
      nonEmptyBuckets(buckets).forEach(type => {
        if (!firstPage) doc.addPage();
        firstPage = false;
        const canvasId = bucketCanvasId('chart_' + secId, type);
        drawSection(buckets[type], `${security} — ${INSTRUMENT_META[type].sectionTitle}`, canvasId, type, margin);
      });
    });
  }

  doc.save(`nport_${allResults.mode}_${today()}.pdf`);
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function showLoading(msg) {
  document.getElementById('loadingBox').innerHTML =
    `<div class="loading-wrap"><div class="spinner"></div><p>${msg || 'Loading…'}</p></div>`;
  setBtnsDisabled(true);
}
function hideLoading() {
  document.getElementById('loadingBox').innerHTML = '';
  setBtnsDisabled(false);
}
function showProgress(text, pct) {
  document.getElementById('progressBox').innerHTML = `
    <div class="progress-bar-wrap">
      <div class="progress-text">${text}</div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>`;
}
function hideProgress() {
  document.getElementById('progressBox').innerHTML = '';
}
function showMsg(msg, type) {
  document.getElementById('msgBox').innerHTML = `<div class="alert alert-${type}">${msg}</div>`;
}
function clearResults() {
  document.getElementById('msgBox').innerHTML = '';
  document.getElementById('resultsContainer').innerHTML = '';
  document.getElementById('dateFilterPanel').style.display = 'none';
  document.getElementById('batchDateFilterPanel').style.display = 'none';
  document.getElementById('creditDateFilterPanel').style.display = 'none';
  document.getElementById('referencePanel').style.display = 'none';
  document.getElementById('creditReferencePanel').style.display = 'none';
  document.getElementById('xraySelectorPanel').style.display = 'none';
  setVal('referencePrice', '');
  setVal('creditReferenceMark', '');
  singleReferenceValue = null;
  creditReferenceValue = null;
  xrayFilings = [];
  xraySnapshots = { current: null, prior: null };
  currentXrayCompare = null;
  xrayCompareMode = null;
  Object.values(singleCharts).forEach(c => c.destroy());
  singleCharts = {};
  if (creditChart) {
    creditChart.destroy();
    creditChart = null;
  }
  Object.values(batchCharts).forEach(c => c.destroy());
  batchCharts = {};
  allResults = {};
  allCreditResults = {};
}
function setBtnsDisabled(v) {
  document.getElementById('searchBtn').disabled = v;
  document.getElementById('batchBtn').disabled = v;
  document.getElementById('creditBtn').disabled = v;
  document.getElementById('xrayBtn').disabled = v;
  const wbtn = document.getElementById('watchlistRunBtn');
  if (wbtn) wbtn.disabled = v || getWatchlist().length === 0;
}

// ── Utilities ──────────────────────────────────────────────────────────────
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function enc(s) {
  return encodeURIComponent(s);
}
function val(id) {
  return document.getElementById(id).value;
}
function setVal(id, v) {
  document.getElementById(id).value = v;
}
function esc(s) {
  return String(s || '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]
  );
}
function cleanId(s) {
  return s.replace(/[^a-zA-Z0-9]/g, '_');
}
function dateCmp(a, b) {
  return new Date(a) - new Date(b);
}
function today() {
  return new Date().toISOString().split('T')[0];
}
function sortFilings(arr) {
  return arr.sort((a, b) =>
    dateCmp(b._source.file_date || b._source.period_ending || 0, a._source.file_date || a._source.period_ending || 0)
  );
}
function fmtCurrency(v) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
}
function fmtNum(v) {
  return new Intl.NumberFormat('en-US').format(Math.round(v));
}
// Compact $ figures (e.g. "$120.09M", "-$1.35B") for aggregate values, where
// full-precision cents (fmtCurrency) just add noise and cause wrapping in
// tight spaces — used anywhere a number represents a fund-level or
// position-level dollar TOTAL, never a per-share price (those stay exact).
function fmtCompactCurrency(v) {
  if (v == null || isNaN(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return fmtCurrency(v);
}
// ── Private Credit: Search ─────────────────────────────────────────────────
async function searchPrivateCredit() {
  const issuer = document.getElementById('creditIssuerInput').value.trim();
  if (!issuer) return showMsg('Please enter an issuer name.', 'error');

  clearResults();
  showLoading('Searching SEC EDGAR for 10-Q filings...');

  try {
    const data = await fetchJSON('/api/search-10q?issuer=' + enc(issuer));
    if (!data.filings?.length) {
      hideLoading();
      return showMsg(
        'No BDC 10-Q filings found for that issuer. The company may not be held by any reporting BDC, or try a more specific name.',
        'error'
      );
    }

    const limit = +document.getElementById('creditFilingLimit').value;
    // Always parse confirmed (EFTS-matched) filings first; fill remaining slots with historical
    const confirmed = data.filings.filter(f => f.confirmed);
    const historical = data.filings.filter(f => !f.confirmed);
    const toparse = [...confirmed, ...historical].slice(0, limit);

    if (data.bdcFunds?.length) {
      showMsg(
        `Found ${data.bdcFunds.length} BDC fund(s) holding this issuer (${data.confirmed} confirmed filings). Parsing…`,
        'info'
      );
    }

    const { holdings, failures } = await parseCreditFilings(toparse, issuer);

    hideLoading();
    hideProgress();

    if (!holdings.length) {
      return showMsg(
        `No schedule of investments data found for "${issuer}" in these 10-Q filings. The filings may mention this issuer in text, not in investment tables.` +
          (failures.length ? ` (${failures.length} filing(s) also failed to fetch/parse.)` : ''),
        'error'
      );
    }

    const fundsMap = groupCreditByFund(holdings);
    allCreditResults = { mode: 'credit', credit: fundsMap };

    const funds = Object.keys(fundsMap).length;
    showMsg(
      `Found ${holdings.length} holding tranche(s) across ${funds} BDC fund(s).` +
        (failures.length
          ? ` ${failures.length} filing(s) failed to parse and were skipped — data may be incomplete.`
          : ''),
      failures.length ? 'warning' : 'success'
    );
    document.getElementById('creditDateFilterPanel').style.display = 'block';
    document.getElementById('creditReferencePanel').style.display = 'block';
    updateURLParams({ tab: 'credit', issuer, limit });
    renderCreditResults(fundsMap, issuer);
  } catch (err) {
    hideLoading();
    hideProgress();
    showMsg('Error: ' + err.message, 'error');
  }
}

// ── Parse credit filings (batches of 4) ───────────────────────────────────
// Returns { holdings, failures } — see parseFilings() above for why failures
// are tracked separately from "filing legitimately had no matching rows".
async function parseCreditFilings(filings, issuer) {
  const all = [];
  const failures = [];
  const batchSize = 4;

  for (let i = 0; i < filings.length; i += batchSize) {
    const batch = filings.slice(i, i + batchSize);
    const pct = Math.round((i / filings.length) * 100);
    const label = batch.map(f => f.company.split(' ').slice(0, 3).join(' ')).join(', ');
    showProgress(`Parsing ${i + 1}–${Math.min(i + batchSize, filings.length)} of ${filings.length}: ${label}…`, pct);

    const results = await Promise.all(
      batch.map(async filing => {
        const { cik, accession, company, period, fileDate, confirmed } = filing;
        const reportDate = period || fileDate || '';
        if (!cik || !accession) {
          failures.push({ company, reason: 'missing CIK/accession' });
          return [];
        }
        try {
          const url = `/api/parse-10q?cik=${enc(cik)}&accession=${enc(accession)}&issuer=${enc(issuer)}&reportDate=${enc(reportDate)}`;
          const parsed = await fetchJSON(url);
          if (!parsed.success) {
            failures.push({ company, reason: parsed.error || 'Unknown error' });
            return [];
          }
          return (parsed.holdings || []).map(h => ({
            ...h,
            company,
            cik,
            accession,
            reportDate: h.reportDate || reportDate,
            confirmed: !!confirmed,
          }));
        } catch (err) {
          failures.push({ company, reason: err.message });
          return [];
        }
      })
    );

    results.forEach(r => all.push(...r));
    if (i + batchSize < filings.length) await sleep(350);
  }

  return { holdings: all, failures };
}

// ── Group credit holdings by fund, deduplicate ────────────────────────────
function groupCreditByFund(holdings) {
  const map = {};
  holdings.forEach(h => {
    if (!map[h.company]) map[h.company] = [];
    map[h.company].push(h);
  });

  Object.keys(map).forEach(company => {
    map[company].sort((a, b) => dateCmp(a.reportDate, b.reportDate));
    const seen = new Set();
    map[company] = map[company].filter(h => {
      const key = `${h.reportDate}_${h.investmentType}_${h.principal}_${h.fairValue}_${h.maturityDate}_${h.spread}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  return map;
}

// ── Credit stats ──────────────────────────────────────────────────────────
function computeCreditStats(fundsMap) {
  const all = Object.values(fundsMap).flat();
  if (!all.length) return null;

  const marks = all.map(h => h.fairValueMark).filter(m => m !== null && m > 0);
  const dates = all
    .map(h => h.reportDate)
    .filter(Boolean)
    .sort();
  const sorted = [...all].filter(h => h.fairValueMark !== null).sort((a, b) => dateCmp(b.reportDate, a.reportDate));

  return {
    latestMark: sorted[0]?.fairValueMark ?? null,
    latestDate: sorted[0]?.reportDate || '',
    minMark: marks.length ? Math.min(...marks) : null,
    maxMark: marks.length ? Math.max(...marks) : null,
    medianMark: median(marks),
    fundCount: Object.keys(fundsMap).length,
    dataPoints: all.length,
    firstDate: dates[0] || '',
    lastDate: dates[dates.length - 1] || '',
  };
}

function creditStatsHTML(stats, referenceValue) {
  if (!stats) return '';
  const fmtMark = v => (v !== null ? v.toFixed(2) + '%' : '—');
  return `
    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-label">Latest Mark</div>
        <div class="stat-value highlight">${fmtMark(stats.latestMark)}</div>
        <div class="stat-sub">${stats.latestDate || '—'}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Mark Range</div>
        <div class="stat-value sm">${fmtMark(stats.minMark)} – ${fmtMark(stats.maxMark)}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Reporting Funds</div>
        <div class="stat-value">${stats.fundCount}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Data Points</div>
        <div class="stat-value">${stats.dataPoints}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Date Range</div>
        <div class="stat-value sm">${stats.firstDate}<br>${stats.lastDate}</div>
      </div>
      ${referenceStatBoxHTML(referenceValue, stats.medianMark, fmtMark)}
    </div>`;
}

// ── Build weighted-average mark datasets for chart ────────────────────────
function buildCreditDatasets(fundsMap) {
  return Object.keys(fundsMap).map((company, i) => {
    const holdings = fundsMap[company];

    // Weighted avg mark per date (weighted by principal)
    const byDate = {};
    holdings.forEach(h => {
      if (!h.reportDate) return;
      if (!byDate[h.reportDate]) byDate[h.reportDate] = { totalFV: 0, totalPrincipal: 0 };
      if (h.principal && h.principal > 0 && h.fairValue !== null) {
        byDate[h.reportDate].totalFV += h.fairValue;
        byDate[h.reportDate].totalPrincipal += h.principal;
      }
    });

    const data = Object.entries(byDate)
      .map(([date, { totalFV, totalPrincipal }]) => ({
        x: date,
        y: totalPrincipal > 0 ? parseFloat(((totalFV / totalPrincipal) * 100).toFixed(2)) : null,
      }))
      .filter(p => p.y !== null)
      .sort((a, b) => dateCmp(a.x, b.x));

    return {
      label: company.substring(0, 46),
      data,
      borderColor: getColor(i),
      backgroundColor: getColor(i) + '22',
      pointRadius: 4,
      pointHoverRadius: 6,
      tension: 0.35,
    };
  });
}

// ── Render credit results ─────────────────────────────────────────────────
function renderCreditResults(fundsMap, _issuer) {
  // Track whatever is actually being displayed (full set or date-filtered)
  // so exports match what's on screen instead of always dumping everything.
  allCreditResults.view = fundsMap;

  const stats = computeCreditStats(fundsMap);

  let html = '<div class="results-section">';
  html += creditStatsHTML(stats, creditReferenceValue);
  html +=
    '<div class="chart-panel"><h3>Fair Value Mark (% of Par) Over Time</h3><div class="chart-canvas-wrap"><canvas id="creditChartCanvas"></canvas></div></div>';
  html += '<div class="results-header"><h2>Holdings by Fund</h2></div>';
  html += renderCreditFundCards(fundsMap);
  html += `<div class="export-row">
    <button class="btn btn-green" onclick="doCreditExportCSV()">Export CSV</button>
    <button class="btn btn-green" onclick="doCreditExportExcel()">Export Excel</button>
  </div>`;
  html += '</div>';

  document.getElementById('resultsContainer').innerHTML = html;

  const ctx = document.getElementById('creditChartCanvas')?.getContext('2d');
  if (ctx) {
    if (creditChart) {
      creditChart.destroy();
      creditChart = null;
    }
    const creditDatasets = buildCreditDatasets(fundsMap);
    if (creditReferenceValue != null) {
      const refDs = buildReferenceLineDataset(creditDatasets, creditReferenceValue, 'Reference Mark');
      if (refDs) creditDatasets.push(refDs);
    }
    creditChart = new Chart(ctx, {
      type: 'line',
      data: { datasets: creditDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, padding: 14, font: { size: 11 } } },
          tooltip: {
            callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(2)}%` },
          },
        },
        scales: {
          x: {
            type: 'time',
            time: { unit: 'month' },
            title: { display: true, text: 'Report Date' },
          },
          y: {
            title: { display: true, text: 'Fair Value Mark (% of Par)' },
            ticks: { callback: v => v.toFixed(1) + '%' },
          },
        },
      },
    });
  }
}

// ── Render credit fund cards ──────────────────────────────────────────────
function renderCreditFundCards(fundsMap) {
  let html = '';

  Object.keys(fundsMap).forEach((company, compIdx) => {
    const holdings = fundsMap[company];
    const latestH = [...holdings]
      .filter(h => h.fairValueMark !== null)
      .sort((a, b) => dateCmp(b.reportDate, a.reportDate))[0];
    const latestMark = latestH ? latestH.fairValueMark.toFixed(2) + '%' : '—';
    const wrapId = `cwrap_${compIdx}`;
    const arrowId = `carrow_${compIdx}`;

    html += `
      <div class="fund-card">
        <div class="fund-header" onclick="toggleFund('${wrapId}','${arrowId}')">
          <div>
            <div class="fund-name">${esc(company)}</div>
            <div class="fund-meta">${holdings.length} tranche(s) &bull; Latest Mark: ${latestMark}</div>
          </div>
          <div class="fund-actions">
            <span class="toggle-arrow up" id="${arrowId}">&#9660;</span>
          </div>
        </div>
        <div class="fund-table-wrap" id="${wrapId}">
          <table>
            <thead><tr>
              <th>Report Date</th>
              <th>Portfolio Company</th>
              <th>Industry</th>
              <th>Index</th>
              <th class="right">Spread</th>
              <th class="right">Cash Int. Rate</th>
              <th class="right">PIK</th>
              <th>Maturity</th>
              <th class="right">Principal ($K)</th>
              <th class="right">Cost ($K)</th>
              <th class="right">Fair Value ($K)</th>
              <th class="right">Mark (%)</th>
              <th>Notes</th>
            </tr></thead>
            <tbody>`;

    holdings.forEach(h => {
      const mark = h.fairValueMark;
      const markStyle =
        mark === null ? '' : mark >= 95 ? '' : mark >= 85 ? 'style="color:var(--amber)"' : 'style="color:var(--red)"';

      html += `
        <tr>
          <td>${sourceLinkHTML(h.cik, h.accession, h.reportDate)}</td>
          <td class="title-cell">${esc(h.portfolioCompany || '—')}</td>
          <td>${esc(h.industry || '—')}</td>
          <td>${esc(h.index || '—')}</td>
          <td class="right">${esc(h.spread || '—')}</td>
          <td class="right">${esc(h.cashInterestRate || '—')}</td>
          <td class="right">${esc(h.pik || '—')}</td>
          <td>${esc(h.maturityDate || '—')}</td>
          <td class="right">${h.principal !== null ? fmtNum(h.principal) : '—'}</td>
          <td class="right">${h.cost !== null ? fmtNum(h.cost) : '—'}</td>
          <td class="right">${h.fairValue !== null ? fmtNum(h.fairValue) : '—'}</td>
          <td class="right price-cell" ${markStyle}>${mark !== null ? mark.toFixed(2) + '%' : '—'}</td>
          <td style="font-size:11px;color:var(--gray-500)">${esc(h.notes || '')}</td>
        </tr>`;
    });

    html += `</tbody></table></div></div>`;
  });

  return html;
}

// ── Credit date filters ───────────────────────────────────────────────────
function applyCreditDateFilter() {
  if (!allCreditResults.credit) return;
  const startTs = val('creditStartDate') ? new Date(val('creditStartDate')).getTime() : 0;
  const endTs = val('creditEndDate') ? new Date(val('creditEndDate')).getTime() : Infinity;

  const filtered = {};
  Object.entries(allCreditResults.credit).forEach(([fund, holdings]) => {
    const filt = holdings.filter(h => {
      const ts = new Date(h.reportDate).getTime();
      return ts >= startTs && ts <= endTs;
    });
    if (filt.length) filtered[fund] = filt;
  });

  if (!Object.keys(filtered).length) {
    showMsg('No data in selected date range.', 'error');
    return;
  }
  renderCreditResults(filtered, '');
  showMsg(`Filter applied: ${Object.values(filtered).flat().length} data point(s) visible.`, 'success');
}

function clearCreditDateFilter() {
  setVal('creditStartDate', '');
  setVal('creditEndDate', '');
  if (allCreditResults.credit) renderCreditResults(allCreditResults.credit, '');
}

// ── Reference/benchmark mark (Private Credit tab) ─────────────────────────
// Re-renders the current view (full or date-filtered) with the reference
// line applied — same pattern as the date filter, since credit cards have
// no per-row checkboxes to preserve across a re-render.
function applyCreditReference() {
  const raw = document.getElementById('creditReferenceMark').value.trim();
  const value = parseFloat(raw);
  if (!raw || isNaN(value) || value < 0) {
    return showMsg('Enter a valid reference mark (%).', 'error');
  }
  creditReferenceValue = value;
  if (allCreditResults.view) renderCreditResults(allCreditResults.view, '');
}
function clearCreditReference() {
  creditReferenceValue = null;
  setVal('creditReferenceMark', '');
  if (allCreditResults.view) renderCreditResults(allCreditResults.view, '');
}

// ── Credit CSV export ─────────────────────────────────────────────────────
function doCreditExportCSV() {
  const rows = [
    [
      'Fund',
      'Report Date',
      'Portfolio Company',
      'Industry',
      'Investment Type',
      'Index',
      'Spread',
      'Cash Int. Rate',
      'PIK',
      'Maturity Date',
      'Principal ($K)',
      'Cost ($K)',
      'Fair Value ($K)',
      'Fair Value Mark (%)',
      'Notes',
      'Source Filing URL',
    ],
  ];
  Object.entries(allCreditResults.view || allCreditResults.credit || {}).forEach(([co, hs]) =>
    hs.forEach(h =>
      rows.push([
        co,
        h.reportDate,
        h.portfolioCompany,
        h.industry,
        h.investmentType,
        h.index,
        h.spread,
        h.cashInterestRate,
        h.pik,
        h.maturityDate,
        h.principal ?? '',
        h.cost ?? '',
        h.fairValue ?? '',
        h.fairValueMark !== null ? h.fairValueMark.toFixed(2) : '',
        h.notes,
        edgarFilingUrl(h.cik, h.accession) || '',
      ])
    )
  );
  const csv = rows.map(r => r.map(c => '"' + String(c ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
  downloadBlob(csv, 'text/csv', `private_credit_${today()}.csv`);
}

// ── Credit Excel export ───────────────────────────────────────────────────
function doCreditExportExcel() {
  const wb = XLSX.utils.book_new();
  const data = [
    [
      'Fund',
      'Report Date',
      'Portfolio Company',
      'Industry',
      'Investment Type',
      'Index',
      'Spread',
      'Cash Int. Rate',
      'PIK',
      'Maturity Date',
      'Principal ($K)',
      'Cost ($K)',
      'Fair Value ($K)',
      'Fair Value Mark (%)',
      'Notes',
      'Source Filing URL',
    ],
  ];
  Object.entries(allCreditResults.view || allCreditResults.credit || {}).forEach(([co, hs]) =>
    hs.forEach(h =>
      data.push([
        co,
        h.reportDate,
        h.portfolioCompany,
        h.industry,
        h.investmentType,
        h.index,
        h.spread,
        h.cashInterestRate,
        h.pik,
        h.maturityDate,
        h.principal,
        h.cost,
        h.fairValue,
        h.fairValueMark !== null ? parseFloat(h.fairValueMark.toFixed(2)) : null,
        h.notes,
        edgarFilingUrl(h.cik, h.accession) || '',
      ])
    )
  );
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [
    { wch: 40 },
    { wch: 12 },
    { wch: 40 },
    { wch: 22 },
    { wch: 30 },
    { wch: 10 },
    { wch: 10 },
    { wch: 14 },
    { wch: 10 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 16 },
    { wch: 20 },
    { wch: 50 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Private Credit');
  XLSX.writeFile(wb, `private_credit_${today()}.xlsx`);
}

function downloadBlob(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

// ── Watchlist: persisted issuer list (localStorage — this browser only) ───
function getWatchlist() {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function saveWatchlist(list) {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
  } catch (_) {}
}
function addWatchlistItem() {
  const input = document.getElementById('watchlistInput');
  const name = input.value.trim();
  if (!name) return;
  const list = getWatchlist();
  if (list.some(n => n.toLowerCase() === name.toLowerCase())) {
    input.value = '';
    return showMsg(`"${name}" is already on your watchlist.`, 'info');
  }
  list.push(name);
  saveWatchlist(list);
  input.value = '';
  renderWatchlist();
}
function removeWatchlistItem(name) {
  saveWatchlist(getWatchlist().filter(n => n !== name));
  renderWatchlist();
}
function quickAddToWatchlist(inputId) {
  const name = document.getElementById(inputId).value.trim();
  if (!name) return showMsg('Enter a security or issuer name first.', 'error');
  const list = getWatchlist();
  if (list.some(n => n.toLowerCase() === name.toLowerCase())) {
    return showMsg(`"${name}" is already on your watchlist.`, 'info');
  }
  list.push(name);
  saveWatchlist(list);
  renderWatchlist();
  showMsg(`Added "${name}" to your watchlist.`, 'success');
}
function renderWatchlist() {
  const list = getWatchlist();
  const container = document.getElementById('watchlistItems');
  const countEl = document.getElementById('watchlistCount');
  const runBtn = document.getElementById('watchlistRunBtn');

  if (countEl) countEl.textContent = list.length;
  if (runBtn) runBtn.disabled = list.length === 0;
  if (!container) return;

  if (!list.length) {
    container.innerHTML =
      '<div class="hint">No issuers saved yet. Add names above, or use the "+ Watchlist" button next to a search box.</div>';
    return;
  }
  container.innerHTML = list
    .map(
      name => `
    <div class="watchlist-item">
      <span>${esc(name)}</span>
      <button class="btn btn-sm btn-red" data-name="${esc(name)}" onclick="removeWatchlistItem(this.dataset.name)">Remove</button>
    </div>
  `
    )
    .join('');
}

// ── Fund X-Ray: total private-market exposure in a fund's own NPORT-P ─────
// Unlike Single Security / Batch / Watchlist (which search for funds
// mentioning a security), this searches for the fund itself, then pulls its
// own filing in full — every holding, not just ones matching a search term
// — so the fund's total private/illiquid book can be measured directly.
async function searchFundXray() {
  const fund = document.getElementById('xrayFundInput').value.trim();
  if (!fund) return showMsg('Please enter a fund or registrant name.', 'error');

  clearResults();
  showLoading('Looking up this fund on SEC EDGAR...');

  try {
    const data = await fetchJSON('/api/search-fund?fund=' + enc(fund));
    hideLoading();

    const matches = data.matches || [];
    const filings = [];
    matches.forEach(m => {
      m.filings.forEach(f => {
        filings.push({
          cik: String(m.cik),
          accession: f.accession,
          company: m.name,
          period: f.reportDate || f.filingDate || '',
          fileDate: f.filingDate || '',
        });
      });
    });
    filings.sort((a, b) => dateCmp(b.period || b.fileDate, a.period || a.fileDate));

    if (!filings.length) {
      return showMsg(
        'No NPORT-P filings found for that fund name. Try the fund’s exact registrant name as it appears on EDGAR (e.g. "SmallCap World Fund Inc", not just "SmallCap").',
        'error'
      );
    }

    xrayFilings = filings;
    xrayCompareMode = null;
    currentXrayCompare = null;
    document.getElementById('xraySelectorPanel').style.display = 'block';
    const optionsHTML = filings
      .map((f, i) => `<option value="${i}">${esc(f.period || f.fileDate)} — ${esc(f.company)}</option>`)
      .join('');
    document.getElementById('xrayFilingSelect').innerHTML = optionsHTML;
    document.getElementById('xrayCompareSelect').innerHTML =
      '<option value="">— No comparison —</option>' + optionsHTML;
    document.getElementById('xrayCompareResults')?.remove();

    if (matches.length > 1) {
      showMsg(`"${fund}" matched ${matches.length} funds on EDGAR — pick the exact fund/period below.`, 'info');
    }

    await runFundXray();
  } catch (err) {
    hideLoading();
    showMsg('Error: ' + err.message, 'error');
  }
}

async function runFundXray() {
  const filing = xrayFilings[+document.getElementById('xrayFilingSelect').value || 0];
  if (!filing) return;

  showLoading('Pulling this filing and classifying every holding...');
  try {
    const data = await fetchJSON(`/api/fund-xray?cik=${enc(filing.cik)}&accession=${enc(filing.accession)}`);
    hideLoading();
    if (!data.success || !data.xray) {
      return showMsg('Error: ' + (data.error || 'Could not parse this filing.'), 'error');
    }
    renderFundXray(data.xray, filing);

    // Keep an active QoQ/YoY comparison in sync with the newly selected
    // Current Period rather than silently going stale.
    if (xrayCompareMode) {
      await selectXrayComparison(xrayCompareMode);
    } else if (document.getElementById('xrayCompareSelect').value) {
      await runFundXrayCompare();
    }
  } catch (err) {
    hideLoading();
    showMsg('Error: ' + err.message, 'error');
  }
}

// Builds one period's full Fund X-Ray breakdown as an HTML string — used
// both for the plain single-period view (opts.periodRole omitted) and,
// when a QoQ/YoY comparison is active, for the "Most Recent Period" /
// "Prior Period" sections that follow the analysis (so it's never ambiguous
// which filing a given block of holdings belongs to).
function buildXraySnapshotHTML(xray, filing, opts) {
  opts = opts || {};
  const fundName = xray.fund?.seriesName || xray.fund?.registrantName || filing.company;
  const pct = v => (v !== null && v !== undefined && !isNaN(v) ? v.toFixed(2) + '%' : '—');

  let html = `<div class="results-section"${opts.sectionId ? ` id="${esc(opts.sectionId)}"` : ''}>`;
  if (opts.periodRole) {
    html += `<div class="results-header"><h2>${esc(opts.periodRole)} &mdash; ${esc(xray.fund?.reportDate || filing.period || '—')}</h2></div>`;
    html += `<div class="hint">${esc(fundName)} &bull; ${sourceLinkHTML(filing.cik, filing.accession, 'View source filing')}</div>`;
  } else {
    html += `<div class="results-header"><h2>${esc(fundName)}</h2></div>`;
    html += `<div class="hint">Report period: ${esc(xray.fund?.reportDate || filing.period || '—')} &bull; ${sourceLinkHTML(filing.cik, filing.accession, 'View source filing')}</div>`;
  }

  html += `
    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-label">Private Equity Exposure</div>
        <div class="stat-value highlight">${fmtCompactCurrency(xray.privateValueUSD)}</div>
        <div class="stat-sub">${xray.privateHoldingsCount} of ${xray.totalHoldingsCount} holdings</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">% of Fund Net Assets</div>
        <div class="stat-value">${pct(xray.privatePctOfNetAssets)}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">% of Reported Holdings Value</div>
        <div class="stat-value">${pct(xray.privatePctOfHoldingsValue)}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Total Holdings</div>
        <div class="stat-value">${xray.totalHoldingsCount}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Fund Net Assets</div>
        <div class="stat-value sm">${xray.fund?.netAssets ? fmtCompactCurrency(xray.fund.netAssets) : '—'}</div>
      </div>
    </div>`;

  html +=
    '<div class="alert alert-info">Private equity = an equity-type interest (common/preferred stock, a warrant, or an indirect/SPV vehicle) that this filing marks at SEC fair-value hierarchy Level 3 — valued with unobservable inputs, meaning there\'s no real market for it — not an external judgment call. Bonds/loans are excluded even at Level 3, since they\'re creditor claims, not equity. A "restricted" flag alone does NOT qualify a holding here: a foreign-ownership-restricted but still publicly-traded stock (Level 2) is excluded, since it trades in an observable market and simply isn\'t privately held. A publicly-traded wrapper around a private company (e.g. a listed vehicle tracking it) will also show as public here, since the fund itself marks it at a quoted price.</div>';

  const typeEntries = Object.entries(xray.byInstrumentType).sort((a, b) => b[1] - a[1]);
  const countryEntries = Object.entries(xray.byCountry).sort((a, b) => b[1] - a[1]);

  if (typeEntries.length) {
    html += '<div class="results-header"><h2>Private Equity Exposure by Instrument Type</h2></div>';
    html +=
      '<table><thead><tr><th>Type</th><th class="right">$ Value</th><th class="right">% of Private Equity Book</th></tr></thead><tbody>';
    typeEntries.forEach(([type, value]) => {
      html += `<tr><td>${esc(type)}</td><td class="right">${fmtCompactCurrency(value)}</td><td class="right">${pct((value / xray.privateValueUSD) * 100)}</td></tr>`;
    });
    html += '</tbody></table>';
  }

  if (countryEntries.length) {
    html += '<div class="results-header"><h2>Private Equity Exposure by Country</h2></div>';
    html +=
      '<table><thead><tr><th>Country</th><th class="right">$ Value</th><th class="right">% of Private Equity Book</th></tr></thead><tbody>';
    countryEntries.forEach(([country, value]) => {
      html += `<tr><td>${esc(country)}</td><td class="right">${fmtCompactCurrency(value)}</td><td class="right">${pct((value / xray.privateValueUSD) * 100)}</td></tr>`;
    });
    html += '</tbody></table>';
  }

  html += `<div class="results-header"><h2>Private Equity Holdings (${xray.privateHoldingsCount})</h2></div>`;
  if (xray.privateHoldings.length) {
    html += `<table><thead><tr>
      <th>Company</th><th>Instrument</th><th>Country</th><th class="right">Fair Value Level</th>
      <th class="right">Shares</th><th class="right">Price / Share</th>
      <th class="right">% of NAV</th><th class="right">$ Value</th>
    </tr></thead><tbody>`;
    xray.privateHoldings.forEach(h => {
      const shares = h.shares != null && !isNaN(h.shares) ? fmtNum(h.shares) : '—';
      const pps = h.pricePerShare != null && !isNaN(h.pricePerShare) ? fmtCurrency(h.pricePerShare) : '—';
      html += `<tr>
        <td class="title-cell">${esc(h.name || h.title || '—')}</td>
        <td>${esc(h.instrumentLabel || '—')}</td>
        <td>${esc(h.country || '—')}</td>
        <td class="right">${esc(h.fairValLevel || '—')}</td>
        <td class="right">${shares}</td>
        <td class="right">${pps}</td>
        <td class="right">${pct(h.pctOfNetAssets)}</td>
        <td class="right">${fmtCompactCurrency(h.marketValue)}</td>
      </tr>`;
    });
    html += '</tbody></table>';
  } else {
    html +=
      '<div class="alert alert-info">No private equity holdings (Level-3 equity, warrants, or SPV vehicles) found in this filing — this fund’s book appears to hold no private equity as of this report date. (It may still hold Level-3 bonds/loans or Level-2 restricted stock, which this view intentionally excludes.)</div>';
  }

  html += `<div class="export-row"><button class="btn btn-green" onclick="doXrayExportCSV('${esc(opts.exportKey || 'current')}')">Export CSV</button></div>`;
  html += '</div>';
  return html;
}

function renderFundXray(xray, filing) {
  xraySnapshots.current = { xray, filing };
  // A comparison already in progress (e.g. the user just changed Current
  // Period while comparing) means this snapshot is no longer the only
  // thing on the page — label it so scrolling past the analysis section
  // never leaves it ambiguous which filing is on screen.
  const compareActive = !!document.getElementById('xrayCompareSelect').value;
  const html = buildXraySnapshotHTML(xray, filing, {
    periodRole: compareActive ? 'Most Recent Period' : null,
    sectionId: 'xraySnapshotCurrent',
    exportKey: 'current',
  });
  document.getElementById('resultsContainer').innerHTML = html;
}

function doXrayExportCSV(key) {
  const snap = xraySnapshots[key || 'current'];
  if (!snap) return;
  const { xray } = snap;
  const fundName = xray.fund?.seriesName || xray.fund?.registrantName || '';
  const reportDate = xray.fund?.reportDate || '';
  const rows = [
    [
      'Fund',
      'Report Date',
      'Company',
      'Instrument',
      'Country',
      'Fair Value Level',
      'Restricted',
      'Shares',
      'Price / Share',
      '% of NAV',
      '$ Value',
    ],
  ];
  xray.privateHoldings.forEach(h =>
    rows.push([
      fundName,
      reportDate,
      h.name || h.title || '',
      h.instrumentLabel || '',
      h.country || '',
      h.fairValLevel || '',
      h.isRestrictedSec || '',
      h.shares != null && !isNaN(h.shares) ? h.shares : '',
      h.pricePerShare != null && !isNaN(h.pricePerShare) ? h.pricePerShare.toFixed(6) : '',
      h.pctOfNetAssets != null ? h.pctOfNetAssets.toFixed(4) : '',
      h.marketValue != null ? h.marketValue.toFixed(2) : '',
    ])
  );
  const csv = rows.map(r => r.map(c => '"' + String(c ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
  const datePart = reportDate ? `_${cleanId(reportDate)}` : '';
  downloadBlob(csv, 'text/csv', `fund_xray_${cleanId(fundName || 'fund')}${datePart}_${today()}.csv`);
}

// ── Fund X-Ray: QoQ / YoY period comparison ────────────────────────────────
// xrayFilings is sorted newest-first (searchFundXray), so "older" always
// means a higher index.
function findXrayComparisonIndex(currentIndex, mode) {
  const current = xrayFilings[currentIndex];
  if (!current) return -1;
  const currentDate = new Date(current.period || current.fileDate);
  if (isNaN(currentDate)) return -1;

  if (mode === 'qoq') {
    return currentIndex + 1 < xrayFilings.length ? currentIndex + 1 : -1;
  }

  // yoy: the older filing whose report date is closest to (current - 365
  // days), accepted only within a +/-45 day tolerance so a fund with gaps
  // in its filing history doesn't get matched to something ~2 years back.
  let bestIndex = -1;
  let bestDiffDays = Infinity;
  for (let i = currentIndex + 1; i < xrayFilings.length; i++) {
    const d = new Date(xrayFilings[i].period || xrayFilings[i].fileDate);
    if (isNaN(d)) continue;
    const daysBack = (currentDate - d) / 86400000;
    if (daysBack < 320 || daysBack > 410) continue;
    const diffDays = Math.abs(daysBack - 365);
    if (diffDays < bestDiffDays) {
      bestDiffDays = diffDays;
      bestIndex = i;
    }
  }
  return bestIndex;
}

// Tears down the comparison UI (both the analysis section and the
// "Prior Period" snapshot) and drops the "Most Recent Period" label off the
// current snapshot, since with nothing to compare against it's just "the"
// view again.
function clearXrayComparisonUI() {
  currentXrayCompare = null;
  xraySnapshots.prior = null;
  document.getElementById('xrayCompareResults')?.remove();
  document.getElementById('xraySnapshotPrior')?.remove();
  const existingCurrent = document.getElementById('xraySnapshotCurrent');
  if (existingCurrent && xraySnapshots.current) {
    existingCurrent.outerHTML = buildXraySnapshotHTML(xraySnapshots.current.xray, xraySnapshots.current.filing, {
      sectionId: 'xraySnapshotCurrent',
      exportKey: 'current',
    });
  }
}

async function selectXrayComparison(mode) {
  xrayCompareMode = mode;
  const currentIndex = +document.getElementById('xrayFilingSelect').value || 0;
  const targetIndex = findXrayComparisonIndex(currentIndex, mode);

  if (targetIndex < 0) {
    document.getElementById('xrayCompareSelect').value = '';
    clearXrayComparisonUI();
    return showMsg(
      mode === 'yoy'
        ? 'No filing found roughly one year prior for this fund.'
        : 'No prior filing available to compare against.',
      'info'
    );
  }

  document.getElementById('xrayCompareSelect').value = String(targetIndex);
  await runFundXrayCompare();
}

// Manual pick from the "Compare To" dropdown — not tied to the qoq/yoy
// nearest-date logic, so it should not be silently re-resolved if Current
// Period changes later.
async function onXrayCompareSelectChange() {
  xrayCompareMode = null;
  await runFundXrayCompare();
}

async function runFundXrayCompare() {
  const compareVal = document.getElementById('xrayCompareSelect').value;
  if (!compareVal) {
    clearXrayComparisonUI();
    return;
  }

  const currentIndex = +document.getElementById('xrayFilingSelect').value || 0;
  const compareIndex = +compareVal;
  const currentFiling = xrayFilings[currentIndex];
  const priorFiling = xrayFilings[compareIndex];
  if (!currentFiling || !priorFiling || currentIndex === compareIndex) {
    document.getElementById('xrayCompareSelect').value = '';
    clearXrayComparisonUI();
    return showMsg('Choose two different periods to compare.', 'error');
  }

  showLoading('Comparing periods...');
  try {
    const data = await fetchJSON(
      `/api/fund-xray-compare?cik=${enc(currentFiling.cik)}&currentAccession=${enc(currentFiling.accession)}&priorAccession=${enc(priorFiling.accession)}`
    );
    hideLoading();
    if (!data.success || !data.comparison) {
      return showMsg('Error: ' + (data.error || 'Could not build this comparison.'), 'error');
    }
    currentXrayCompare = data.comparison;
    // Order on the page: 1) analysis (prepended, see renderFundXrayComparison)
    // 2) the current snapshot already in #resultsContainer, now relabeled
    // "Most Recent Period" since it's no longer the only thing shown
    // 3) the prior period's own full breakdown, fetched below and appended
    // last — so scrolling down goes newest -> oldest, analysis always first.
    renderFundXrayComparison(data.comparison, currentFiling, priorFiling);
    relabelCurrentXraySnapshot();
    await renderPriorXraySnapshot(priorFiling);
  } catch (err) {
    hideLoading();
    showMsg('Error: ' + err.message, 'error');
  }
}

function relabelCurrentXraySnapshot() {
  const existing = document.getElementById('xraySnapshotCurrent');
  if (!existing || !xraySnapshots.current) return;
  existing.outerHTML = buildXraySnapshotHTML(xraySnapshots.current.xray, xraySnapshots.current.filing, {
    periodRole: 'Most Recent Period',
    sectionId: 'xraySnapshotCurrent',
    exportKey: 'current',
  });
}

// Fetches (almost always a cache hit — the comparison call above already
// warmed it server-side) and renders the prior period's own full
// breakdown, appended after the current snapshot. Non-fatal on failure:
// the comparison analysis above already has everything needed, this is a
// supplementary "see that period's own report" convenience.
async function renderPriorXraySnapshot(priorFiling) {
  try {
    const data = await fetchJSON(`/api/fund-xray?cik=${enc(priorFiling.cik)}&accession=${enc(priorFiling.accession)}`);
    if (!data.success || !data.xray) return;
    xraySnapshots.prior = { xray: data.xray, filing: priorFiling };
    const html = buildXraySnapshotHTML(data.xray, priorFiling, {
      periodRole: 'Prior Period',
      sectionId: 'xraySnapshotPrior',
      exportKey: 'prior',
    });
    const existing = document.getElementById('xraySnapshotPrior');
    if (existing) {
      existing.outerHTML = html;
    } else {
      document.getElementById('resultsContainer').insertAdjacentHTML('beforeend', html);
    }
  } catch (_err) {
    // Supplementary content — swallow rather than surfacing an error over
    // an already-successful comparison render.
  }
}

// Renders "prior → current (+/-X.X%)" for a {current, prior, delta, deltaPct}
// block, using fmt to format each side (fmtCurrency, fmtNum, etc.).
function fmtXrayDeltaPair(block, fmt) {
  if (block.current == null && block.prior == null) return '—';
  if (block.prior == null) return `${fmt(block.current)} <span style="color:var(--green)">(new)</span>`;
  if (block.current == null) return `${fmt(block.prior)} <span style="color:var(--red)">(exited)</span>`;
  let pctLabel = '';
  if (block.deltaPct != null && !isNaN(block.deltaPct)) {
    const color = block.deltaPct > 0 ? 'var(--green)' : block.deltaPct < 0 ? 'var(--red)' : 'var(--gray-500)';
    pctLabel = ` <span style="color:${color}">(${block.deltaPct > 0 ? '+' : ''}${block.deltaPct.toFixed(1)}%)</span>`;
  }
  return `${fmt(block.prior)} → ${fmt(block.current)}${pctLabel}`;
}

// Renders one "Key Insights" card: a title, up to a handful of items, and a
// "+N more in the table below" note when the underlying list (already
// capped server-side, see buildFundXRayComparison's `capped()`) was longer.
function insightCardHTML(title, list, renderItem, emptyLabel) {
  let html = `<div class="insight-card"><h4>${esc(title)}</h4>`;
  if (!list.items.length) {
    html += `<div class="insight-empty">${esc(emptyLabel)}</div>`;
  } else {
    html += '<ul class="insight-list">';
    list.items.forEach(p => {
      html += `<li class="insight-item"><span class="insight-name" title="${esc(p.name || p.title || '')}">${esc(p.name || p.title || '—')}</span>${renderItem(p)}</li>`;
    });
    html += '</ul>';
    if (list.total > list.items.length) {
      html += `<div class="insight-more">+${list.total - list.items.length} more in the table below</div>`;
    }
  }
  html += '</div>';
  return html;
}

function renderFundXrayComparison(cmp, currentFiling, priorFiling) {
  const t = cmp.totals;
  const deltaColor = v => (v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--gray-900)');
  const signed = v => (v > 0 ? '+' : '') + v;
  const pctLabel = v => (v == null || isNaN(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
  const metric = (text, color) => `<span class="insight-metric" style="color:${color}">${text}</span>`;

  let html = '<div class="results-section" id="xrayCompareResults">';
  html += `<div class="results-header"><h2>Period Comparison</h2></div>`;
  html += `<div class="hint">Current: ${esc(cmp.current.reportDate || '—')} (${sourceLinkHTML(currentFiling.cik, currentFiling.accession, 'view filing')}) &bull; Prior: ${esc(cmp.prior.reportDate || '—')} (${sourceLinkHTML(priorFiling.cik, priorFiling.accession, 'view filing')})</div>`;

  html += `
    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-label">Private Equity Value</div>
        <div class="stat-value highlight">${fmtCompactCurrency(t.privateValueUSD.current)}</div>
        <div class="stat-sub" style="color:${deltaColor(t.privateValueUSD.delta)}">${pctLabel(t.privateValueUSD.deltaPct)} vs ${fmtCompactCurrency(t.privateValueUSD.prior)}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Private Holdings</div>
        <div class="stat-value">${t.privateHoldingsCount.current}</div>
        <div class="stat-sub" style="color:${deltaColor(t.privateHoldingsCount.delta)}">${signed(t.privateHoldingsCount.delta)} vs ${t.privateHoldingsCount.prior}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Distinct Issuers</div>
        <div class="stat-value">${t.issuerCount.current}</div>
        <div class="stat-sub" style="color:${deltaColor(t.issuerCount.delta)}">${signed(t.issuerCount.delta)} vs ${t.issuerCount.prior}</div>
      </div>
    </div>`;

  // "Of the $ change in positions still held, how much was the fund
  // marking them up/down (a re-rate of the same shares) vs. buying more or
  // selling some down (a change in position size)?" — the two effects sum
  // exactly to the continuing-position value change (buildFundXRayComparison).
  html += `
    <div class="results-header"><h2>What Drove The Change</h2></div>
    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-label">Value &Delta; from Price Marks</div>
        <div class="stat-value" style="color:${deltaColor(t.valueChangeFromPrice.amount)}">${fmtCompactCurrency(t.valueChangeFromPrice.amount)}</div>
        <div class="stat-sub">${pctLabel(t.valueChangeFromPrice.pct)} of continuing positions' prior value</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Value &Delta; from Position Sizing</div>
        <div class="stat-value" style="color:${deltaColor(t.valueChangeFromShares.amount)}">${fmtCompactCurrency(t.valueChangeFromShares.amount)}</div>
        <div class="stat-sub">${pctLabel(t.valueChangeFromShares.pct)} of continuing positions' prior value</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">New Investments</div>
        <div class="stat-value" style="color:var(--green)">${t.newCount}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Exited Investments</div>
        <div class="stat-value" style="color:var(--red)">${t.exitedCount}</div>
      </div>
    </div>`;

  const ins = cmp.insights;
  html += '<div class="results-header"><h2>Key Insights</h2></div>';
  html += '<div class="insight-grid">';
  html += insightCardHTML(
    'Securities Added',
    ins.added,
    p => metric(fmtCompactCurrency(p.marketValue.current), 'var(--green)'),
    'No new investments this period.'
  );
  html += insightCardHTML(
    'Securities Dropped',
    ins.dropped,
    p => metric(fmtCompactCurrency(p.marketValue.prior), 'var(--red)'),
    'No investments exited this period.'
  );
  html += insightCardHTML(
    'Positions Increased (added shares)',
    ins.increased,
    p => metric(`+${fmtNum(p.shares.delta)} sh (${pctLabel(p.shares.deltaPct)})`, 'var(--green)'),
    'No continuing position was added to.'
  );
  html += insightCardHTML(
    'Positions Reduced (sold shares)',
    ins.reduced,
    p => metric(`${fmtNum(p.shares.delta)} sh (${pctLabel(p.shares.deltaPct)})`, 'var(--red)'),
    'No continuing position was partially sold down.'
  );
  // Ranked (in buildFundXRayComparison) by the $ impact of the mark move,
  // not raw %, so a real $37M mark-up doesn't get buried under a
  // technically-larger but economically trivial % move on a near-zero-price
  // position — the $ figure shown here is that same ranking metric, with
  // the price-per-share move itself alongside for context.
  html += insightCardHTML(
    'Notable Mark-Ups',
    ins.topMarkups,
    p =>
      metric(
        `${fmtCompactCurrency(p.priceEffectUSD)} (${fmtCurrency(p.pricePerShare.prior)} &rarr; ${fmtCurrency(p.pricePerShare.current)})`,
        'var(--green)'
      ),
    'No continuing position was marked up.'
  );
  html += insightCardHTML(
    'Notable Mark-Downs',
    ins.topMarkdowns,
    p =>
      metric(
        `${fmtCompactCurrency(p.priceEffectUSD)} (${fmtCurrency(p.pricePerShare.prior)} &rarr; ${fmtCurrency(p.pricePerShare.current)})`,
        'var(--red)'
      ),
    'No continuing position was marked down.'
  );
  html += '</div>';

  html += `<div class="results-header"><h2>Full Position-Level Detail (${cmp.positions.length})</h2></div>`;
  if (cmp.positions.length) {
    html += `<table><thead><tr>
      <th>Status</th><th>Company</th><th>Instrument</th>
      <th class="right">Shares (prior &rarr; current)</th>
      <th class="right">Price / Share (prior &rarr; current)</th>
      <th class="right">Value (prior &rarr; current)</th>
      <th class="right">% of NAV &Delta;</th>
    </tr></thead><tbody>`;
    cmp.positions.forEach(p => {
      const rowClass = p.status === 'new' ? 'xray-new-row' : p.status === 'exited' ? 'xray-exited-row' : '';
      const navDelta =
        p.pctOfNetAssets.delta != null
          ? `${p.pctOfNetAssets.delta > 0 ? '+' : ''}${p.pctOfNetAssets.delta.toFixed(2)}pp`
          : '—';
      html += `<tr class="${rowClass}">
        <td><span class="status-pill ${p.status}">${p.status}</span></td>
        <td class="title-cell">${esc(p.name || p.title || '—')}</td>
        <td>${esc(p.instrumentLabel || '—')}</td>
        <td class="right">${fmtXrayDeltaPair(p.shares, fmtNum)}</td>
        <td class="right">${fmtXrayDeltaPair(p.pricePerShare, fmtCurrency)}</td>
        <td class="right">${fmtXrayDeltaPair(p.marketValue, fmtCompactCurrency)}</td>
        <td class="right">${navDelta}</td>
      </tr>`;
    });
    html += '</tbody></table>';
  } else {
    html += '<div class="alert alert-info">No private equity holdings in either period.</div>';
  }

  html += `<div class="export-row"><button class="btn btn-green" onclick="doXrayCompareExportCSV()">Export Comparison CSV</button></div>`;
  html += '</div>';

  // Insights are the whole point of comparing two periods — they belong
  // ABOVE the single-period breakdown (which renderFundXray already put in
  // #resultsContainer), not buried below a long holdings table a user has
  // to scroll past first.
  const existing = document.getElementById('xrayCompareResults');
  if (existing) {
    existing.outerHTML = html;
  } else {
    document.getElementById('resultsContainer').insertAdjacentHTML('afterbegin', html);
  }
}

function doXrayCompareExportCSV() {
  if (!currentXrayCompare) return;
  const cmp = currentXrayCompare;
  const rows = [
    [
      'Status',
      'Company',
      'Instrument',
      'Shares (Prior)',
      'Shares (Current)',
      'Shares Δ%',
      'Price/Share (Prior)',
      'Price/Share (Current)',
      'Price/Share Δ%',
      'Value (Prior)',
      'Value (Current)',
      'Value Δ%',
      'Value Δ from Price Mark ($)',
      'Value Δ from Position Sizing ($)',
      '% of NAV (Prior)',
      '% of NAV (Current)',
    ],
  ];
  cmp.positions.forEach(p =>
    rows.push([
      p.status,
      p.name || p.title || '',
      p.instrumentLabel || '',
      p.shares.prior ?? '',
      p.shares.current ?? '',
      p.shares.deltaPct != null ? p.shares.deltaPct.toFixed(2) : '',
      p.pricePerShare.prior != null ? p.pricePerShare.prior.toFixed(6) : '',
      p.pricePerShare.current != null ? p.pricePerShare.current.toFixed(6) : '',
      p.pricePerShare.deltaPct != null ? p.pricePerShare.deltaPct.toFixed(2) : '',
      p.marketValue.prior != null ? p.marketValue.prior.toFixed(2) : '',
      p.marketValue.current != null ? p.marketValue.current.toFixed(2) : '',
      p.marketValue.deltaPct != null ? p.marketValue.deltaPct.toFixed(2) : '',
      p.priceEffectUSD != null ? p.priceEffectUSD.toFixed(2) : '',
      p.shareEffectUSD != null ? p.shareEffectUSD.toFixed(2) : '',
      p.pctOfNetAssets.prior != null ? p.pctOfNetAssets.prior.toFixed(4) : '',
      p.pctOfNetAssets.current != null ? p.pctOfNetAssets.current.toFixed(4) : '',
    ])
  );
  const csv = rows.map(r => r.map(c => '"' + String(c ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
  const fundName = cmp.current.seriesName || cmp.current.registrantName || '';
  downloadBlob(csv, 'text/csv', `fund_xray_compare_${cleanId(fundName || 'fund')}_${today()}.csv`);
}
