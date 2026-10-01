/* exported showCompanyView, renderCompanyActivity, renderCompanyClasses, loadMarket, loadFeed, loadFirms,
   openFirm, exportFirmBook, loadFirmChanges, loadFirmMarks, loadFundChanges, attachCompanyViews, exportCsv,
   CHANGE_COLUMNS, renderFeed, loadTracked, sortTracked, trackedState, marketState, feedState, firmState, firmsState, companyView */
/* global fetchJSON, esc, enc, fmtNum, fmtCurrency, fmtCompactCurrency, badge, accessionLink, slugOf, downloadBlob,
   fileNamePart, switchTab */
// Analysis views on the warehouse (ROADMAP §6), loaded after app.js and using
// its helpers (fetchJSON, esc, enc, fmt*, badge, accessionLink, slugOf,
// downloadBlob). Every row shows its fund's mark date and links its filing;
// changes are worded as the filings allow ("first reported", "no longer
// reported"), never with a guessed cause.
//   Company page: Activity (position changes), Trend (holders and value by
//   month), Share classes (every fund's mark per class, gaps and spreads).
//   Market tab: private companies as of a date, by country, and what's new.
//   Firms tab: firms by private value; a firm's book, marks and changes.

const VIEW_CHARTS = {};
function viewChart(id, config) {
  if (VIEW_CHARTS[id]) VIEW_CHARTS[id].destroy();
  const el = document.getElementById(id);
  if (!el || typeof Chart === 'undefined') return;
  VIEW_CHARTS[id] = new Chart(el, config);
}
const pctText = (v, digits = 1) => (v == null || isNaN(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`);
const priceText = (price, perShare) => (price == null ? '—' : fmtCurrency(price) + (perShare ? '/sh' : '/unit'));
const sharesText = v => (v == null ? '—' : fmtNum(Math.round(v)));
const companyLink = (id, name) => `<a href="/company/${enc(id)}-${slugOf(name)}">${esc(name)}</a>`;
const fundLink = (fundKey, label) => `<a href="/fund/${enc(fundKey)}">${esc(label || fundKey)}</a>`;
const firmLink = (id, name) =>
  `<a href="/firm/${enc(id)}" onclick="openFirm(${Number(id)});return false;">${esc(name)}</a>`;
const CHANGE_CLASS = {
  new: 'badge-ok',
  added: 'badge-ok',
  reduced: 'badge-warn',
  exited: 'badge-warn',
  zeroed: 'badge-warn',
  mixed: 'badge-muted',
  unchanged: 'badge-muted',
  firstFiling: 'badge-muted',
  resumed: 'badge-muted',
};

function csvOf(columns, rows) {
  const cell = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(c => cell(c[0])).join(','), ...rows.map(r => columns.map(c => cell(c[1](r))).join(','))].join(
    '\n'
  );
}
function exportCsv(name, columns, rows) {
  downloadBlob(csvOf(columns, rows), 'text/csv;charset=utf-8', `${fileNamePart(name)}.csv`);
}

// One position change as a table row. withCompany: the feed and fund/firm
// views name the company; the company page names the fund.
function changeRowHTML(e, { withCompany = false, withFund = true } = {}) {
  const legs = e.instruments
    .map(i => {
      const shares =
        i.prevBalance != null && i.balance != null
          ? `${sharesText(i.prevBalance)} → ${sharesText(i.balance)}${i.split ? ` (split ${i.split}:1)` : ''}`
          : i.balance != null
            ? sharesText(i.balance)
            : i.prevBalance != null
              ? `${sharesText(i.prevBalance)} → none`
              : 'no share count';
      const mark =
        i.prevPrice != null && i.price != null
          ? `${priceText(i.prevPrice, i.perShare)} → ${priceText(i.price, i.perShare)} (${pctText(i.priceChangePct)})`
          : priceText(i.price ?? i.prevPrice, i.perShare);
      return `<div>${esc(i.instrument || i.title || '')}: ${shares} · ${mark}${i.change !== e.type ? ` <span class="fund-meta">${esc(i.change)}</span>` : ''}</div>`;
    })
    .join('');
  return `<tr>
    <td>${esc(e.markDate)}<div class="fund-meta">prior ${esc(e.prevMarkDate || '—')}</div></td>
    ${withCompany ? `<td>${companyLink(e.companyId, e.company)}${e.tracked ? ' ' + badge('Tracked') : ''}</td>` : ''}
    ${withFund ? `<td>${fundLink(e.fundKey, e.fundLabel || e.seriesName)}<div class="fund-meta">${esc(e.registrant || '')}</div></td>` : ''}
    <td>${badge(e.label, CHANGE_CLASS[e.type] || 'badge-muted')}</td>
    <td class="right">${fmtCompactCurrency(e.prevValue)} → ${fmtCompactCurrency(e.value)}</td>
    <td>${legs}</td>
    <td>${accessionLink(e.cik, e.accession)}<div class="fund-meta">filed ${esc(e.filingDate)}</div></td>
  </tr>`;
}
function changesTableHTML(events, opts = {}) {
  if (!events.length) return '<div class="hint">No changes in this window.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>Mark date</th>${opts.withCompany ? '<th>Company</th>' : ''}${
    opts.withFund === false ? '' : '<th>Fund</th>'
  }<th>Change</th><th class="right">Value</th><th>Shares and mark</th><th>Filing</th></tr></thead><tbody>${events
    .map(e => changeRowHTML(e, opts))
    .join('')}</tbody></table></div>`;
}
const CHANGE_COLUMNS = [
  ['Mark Date', e => e.markDate],
  ['Prior Mark Date', e => e.prevMarkDate],
  ['Company', e => e.company || ''],
  ['Fund', e => e.fundLabel || e.seriesName],
  ['Fund Key', e => e.fundKey],
  ['Change', e => e.label],
  ['Prior Value', e => e.prevValue],
  ['Value', e => e.value],
  ['Mark Change %', e => (e.markChangePct == null ? '' : e.markChangePct.toFixed(2))],
  [
    'Instruments',
    e =>
      e.instruments
        .map(
          i => `${i.instrument}: ${i.prevBalance ?? ''}->${i.balance ?? ''} @ ${i.prevPrice ?? ''}->${i.price ?? ''}`
        )
        .join('; '),
  ],
  ['Accession', e => e.accession],
  ['Prior Accession', e => e.prevAccession || ''],
  ['Filing Date', e => e.filingDate],
  ['Source', () => 'SEC N-PORT (warehouse)'],
];

// ── Company page sections ──────────────────────────────────────────────────
let companyView = null; // { base, name, activity?, trend?, classes?, marks? }

function companyViewsHTML() {
  return `<div class="view-tabs" id="companyViewTabs">
      <button class="btn btn-secondary" onclick="showCompanyView('activity')">Activity: adds, new holders, exits</button>
      <button class="btn btn-secondary" onclick="showCompanyView('trend')">Trend</button>
      <button class="btn btn-secondary" onclick="showCompanyView('classes')">Share classes and marks</button>
    </div>
    <div id="companyViewBox"></div>`;
}

// Called by app.js after the company page renders.
function attachCompanyViews(c) {
  const base = c.kind === 'company' ? `/api/companies/${enc(c.ref)}` : `/api/entities/${enc(c.ref)}`;
  companyView = { base, name: c.name, stored: !!c.stored, date: c.exposure?.date };
  const slot = document.getElementById('companyViewsSlot');
  if (slot) slot.innerHTML = companyViewsHTML();
}

async function showCompanyView(which) {
  const v = companyView;
  if (!v) return;
  const box = document.getElementById('companyViewBox');
  box.innerHTML = '<div class="hint">Loading from the warehouse…</div>';
  const q = v.stored ? 'stored=1' : '';
  try {
    if (which === 'activity') {
      v.activity ||= await fetchJSON(`${v.base}/activity?${q}`);
      renderCompanyActivity();
    } else if (which === 'trend') {
      v.trend ||= await fetchJSON(`${v.base}/trend?${q}`);
      v.activity ||= await fetchJSON(`${v.base}/activity?${q}`);
      renderCompanyTrend();
    } else {
      [v.classes, v.marks, v.stale] = await Promise.all([
        fetchJSON(`${v.base}/classes?date=${enc(v.date || '')}&${q}`),
        v.marks || fetchJSON(`${v.base}/marks?${q}`),
        v.stale || fetchJSON(`${v.base}/stale?${q}`),
      ]);
      renderCompanyClasses();
    }
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

function renderCompanyActivity() {
  const v = companyView;
  const filter = document.getElementById('activityFilter')?.value || 'moves';
  const keep = {
    moves: e => e.type !== 'unchanged' || Math.abs(e.markChangePct || 0) > 0,
    holders: e => ['new', 'added', 'reduced', 'mixed', 'exited', 'zeroed'].includes(e.type),
    new: e => e.type === 'new',
    exited: e => e.type === 'exited' || e.type === 'zeroed',
    marks: e => e.markChangePct != null && Math.abs(e.markChangePct) > 0.05,
  }[filter];
  const events = v.activity.events.filter(keep);
  const last = v.activity.byMonth.slice(-12);
  const counts = t => last.reduce((n, m) => n + (m[t] || 0), 0);
  document.getElementById('companyViewBox').innerHTML = `
    <h3>Position changes, filing by filing</h3>
    <div class="hint">Each row compares a fund's filing with the same fund's previous one. Funds file on staggered calendars, so changes are dated by each fund's own mark date. Shares are compared after splits; "no longer reported" means the filing no longer lists the company.</div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">First reported (12 mo)</div><div class="stat-value">${fmtNum(counts('new'))}</div></div>
      <div class="stat-card"><div class="stat-label">Added</div><div class="stat-value">${fmtNum(counts('added'))}</div></div>
      <div class="stat-card"><div class="stat-label">Reduced</div><div class="stat-value">${fmtNum(counts('reduced'))}</div></div>
      <div class="stat-card"><div class="stat-label">No longer reported</div><div class="stat-value">${fmtNum(counts('exited'))}</div></div>
      <div class="stat-card"><div class="stat-label">Mark-ups / downs</div><div class="stat-value">${fmtNum(counts('markUps'))} / ${fmtNum(counts('markDowns'))}</div></div>
    </div>
    <div class="search-row">
      <div class="input-group narrow"><label for="activityFilter">Show</label><select id="activityFilter" onchange="renderCompanyActivity()">
        <option value="moves"${filter === 'moves' ? ' selected' : ''}>Every change and mark move</option>
        <option value="holders"${filter === 'holders' ? ' selected' : ''}>Position changes only</option>
        <option value="new"${filter === 'new' ? ' selected' : ''}>New holders</option>
        <option value="exited"${filter === 'exited' ? ' selected' : ''}>No longer reported / $0</option>
        <option value="marks"${filter === 'marks' ? ' selected' : ''}>Mark moves</option>
      </select></div>
      <button class="btn btn-green" onclick="exportCsv(companyView.name + ' activity', CHANGE_COLUMNS, companyView.activity.events)">Export CSV</button>
    </div>
    <div class="hint">${fmtNum(events.length)} of ${fmtNum(v.activity.events.length)} changes.</div>
    ${changesTableHTML(events.slice(0, 400))}
    ${events.length > 400 ? '<div class="hint">Showing the newest 400; the CSV has all of them.</div>' : ''}`;
}

function renderCompanyTrend() {
  const v = companyView;
  const pts = v.trend.points;
  const months = new Map(v.activity.byMonth.map(m => [m.month, m]));
  document.getElementById('companyViewBox').innerHTML = `
    <h3>Holders and value at each month end</h3>
    <div class="hint">At each month end, every fund counts at its latest filing on or before that date (none older than 123 days). The newest months are still being filed (filings arrive about 60 days after the report date).</div>
    <div class="chart-wrap"><canvas id="trendChart" height="110"></canvas></div>
    <div class="table-wrap"><table><thead><tr><th>Month end</th><th class="right">Funds</th><th class="right">Value</th><th class="right">Entered</th><th class="right">Left</th><th class="right">First reported</th><th class="right">Added</th><th class="right">Reduced</th><th class="right">No longer reported</th><th class="right">Mark-ups / downs</th></tr></thead><tbody>${[
      ...pts,
    ]
      .reverse()
      .map(p => {
        const m = months.get(p.date.slice(0, 7)) || {};
        return `<tr><td>${esc(p.date)}</td><td class="right">${fmtNum(p.funds)}</td><td class="right">${fmtCompactCurrency(p.total)}</td><td class="right">${fmtNum(p.entered)}</td><td class="right">${fmtNum(p.left)}</td><td class="right">${fmtNum(m.new || 0)}</td><td class="right">${fmtNum(m.added || 0)}</td><td class="right">${fmtNum(m.reduced || 0)}</td><td class="right">${fmtNum(m.exited || 0)}</td><td class="right">${fmtNum(m.markUps || 0)} / ${fmtNum(m.markDowns || 0)}</td></tr>`;
      })
      .join('')}</tbody></table></div>
    <button class="btn btn-green" onclick="exportCsv(companyView.name + ' trend', [['Month End', p => p.date], ['Funds', p => p.funds], ['Value USD', p => p.total], ['Entered', p => p.entered], ['Left', p => p.left], ['Source', () => 'SEC N-PORT (warehouse)']], companyView.trend.points)">Export CSV</button>`;
  viewChart('trendChart', {
    type: 'line',
    data: {
      labels: pts.map(p => p.date),
      datasets: [
        { label: 'Value (USD)', data: pts.map(p => p.total), yAxisID: 'y', borderColor: '#1f3a5f', pointRadius: 0 },
        { label: 'Funds', data: pts.map(p => p.funds), yAxisID: 'y1', borderColor: '#c9a227', pointRadius: 0 },
      ],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { position: 'left', ticks: { callback: x => fmtCompactCurrency(x) } },
        y1: { position: 'right', grid: { drawOnChartArea: false } },
      },
    },
  });
}

function renderCompanyClasses() {
  const v = companyView;
  const c = v.classes;
  const classes = v.marks.classes;
  const pick = document.getElementById('classPick')?.value || classes[0];
  const series = v.marks.series.filter(s => s.instrument === pick);
  document.getElementById('companyViewBox').innerHTML = `
    <h3>Share classes as of ${esc(c.date)}</h3>
    <div class="hint">Per-share marks come from share rows only (vehicle units and warrants are per unit). Funds are compared at the same mark date, as filed; the filings never state the valuation method, so a gap is a gap, not a method.</div>
    <div class="table-wrap"><table><thead><tr><th>Class</th><th class="right">Value</th><th class="right">Funds</th><th>Newest mark date</th><th class="right">Median</th><th class="right">Low – High</th><th class="right">Spread</th><th>Firms</th></tr></thead><tbody>${c.classes
      .map(k => {
        const d = k.byMarkDate[0];
        return `<tr><td>${esc(k.instrument)}</td><td class="right">${fmtCompactCurrency(k.value)}</td><td class="right">${fmtNum(k.funds)}</td><td>${esc(d?.markDate || '—')}</td><td class="right">${d ? fmtCurrency(d.median) : '—'}</td><td class="right">${d ? `${fmtCurrency(d.low)} – ${fmtCurrency(d.high)}` : '—'}</td><td class="right">${d && d.funds > 1 ? pctText(d.spreadPct, 2) : '—'}</td><td>${(d?.firms || []).map(f => firmLink(f.id, f.name)).join(', ')}</td></tr>`;
      })
      .join('')}</tbody></table></div>
    ${
      c.withinFiling.length
        ? `<h3>Class gaps within one filing</h3><div class="hint">One fund marking classes of the same company at different prices in the same filing.</div><div class="table-wrap"><table><thead><tr><th>Fund</th><th>Firm</th><th>Mark date</th><th>Classes (vs the filing's lowest mark)</th><th>Filing</th></tr></thead><tbody>${c.withinFiling
            .map(
              w =>
                `<tr><td>${fundLink(w.fundKey, w.fund)}</td><td>${(w.firms || []).map(f => firmLink(f.id, f.name)).join(', ') || '—'}</td><td>${esc(w.markDate)}</td><td>${w.classes
                  .map(x => `${esc(x.instrument)} ${fmtCurrency(x.pricePerShare)} (${pctText(x.vsLowPct, 2)})`)
                  .join('<br>')}</td><td>${accessionLink(w.cik, w.accession)}</td></tr>`
            )
            .join('')}</tbody></table></div>`
        : ''
    }
    ${staleHTML(v.stale)}
    <h3>Per-share marks over time</h3>
    <div class="search-row"><div class="input-group narrow"><label for="classPick">Class</label><select id="classPick" onchange="renderCompanyClasses()">${classes
      .map(k => `<option${k === pick ? ' selected' : ''}>${esc(k)}</option>`)
      .join('')}</select></div></div>
    <div class="chart-wrap"><canvas id="classChart" height="100"></canvas></div>
    <div class="table-wrap"><table><thead><tr><th>Mark date</th><th class="right">Funds</th><th class="right">Firms</th><th class="right">Median</th><th class="right">Low</th><th class="right">High</th></tr></thead><tbody>${[
      ...series,
    ]
      .reverse()
      .map(
        s =>
          `<tr><td>${esc(s.markDate)}</td><td class="right">${fmtNum(s.funds)}</td><td class="right">${fmtNum(s.firms)}</td><td class="right">${fmtCurrency(s.median)}</td><td class="right">${fmtCurrency(s.low)}</td><td class="right">${fmtCurrency(s.high)}</td></tr>`
      )
      .join('')}</tbody></table></div>
    <button class="btn btn-green" onclick="exportCsv(companyView.name + ' class marks', [['Mark Date', s => s.markDate], ['Class', s => s.instrument], ['Funds', s => s.funds], ['Firms', s => s.firms], ['Median USD/sh', s => s.median], ['Low', s => s.low], ['High', s => s.high], ['Source', () => 'SEC N-PORT (warehouse)']], companyView.marks.series)">Export CSV</button>`;
  viewChart('classChart', {
    type: 'line',
    data: {
      labels: series.map(s => s.markDate),
      datasets: [
        { label: 'Median', data: series.map(s => s.median), borderColor: '#1f3a5f', pointRadius: 2 },
        { label: 'Low', data: series.map(s => s.low), borderColor: '#9aa5b1', borderDash: [4, 4], pointRadius: 0 },
        { label: 'High', data: series.map(s => s.high), borderColor: '#9aa5b1', borderDash: [4, 4], pointRadius: 0 },
      ],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { y: { ticks: { callback: x => fmtCurrency(x) } } },
    },
  });
}

// Funds carrying an unchanged mark while the class's median moved.
function staleHTML(st) {
  if (!st?.stale?.length) return '';
  return `<h3>Stale marks</h3><div class="hint">Funds still filing the same per-share mark for ${fmtNum(st.minReports)}+ consecutive reports while the median mark of that class across all funds moved more than ${fmtNum(st.moveThreshold)}%.</div>
    <div class="table-wrap"><table><thead><tr><th>Fund</th><th>Firm</th><th>Class</th><th class="right">Mark</th><th>Unchanged since</th><th class="right">Reports</th><th class="right">Market median then → now</th><th>Latest filing</th></tr></thead><tbody>${st.stale
      .map(
        x =>
          `<tr><td>${fundLink(x.fundKey, x.fund)}</td><td>${x.firms.map(f => firmLink(f.id, f.name)).join(', ') || '—'}</td><td>${esc(x.instrument)}</td><td class="right">${fmtCurrency(x.pricePerShare)}</td><td>${esc(x.unchangedSince)}</td><td class="right">${fmtNum(x.reports)}</td><td class="right">${fmtCurrency(x.marketMedianThen)} → ${fmtCurrency(x.marketMedianNow)} (${pctText(x.marketMovePct)})</td><td>${accessionLink(x.cik, x.accession)} ${esc(x.lastMarkDate)}</td></tr>`
      )
      .join('')}</tbody></table></div>`;
}

// ── Freshness banner ──
async function loadFreshness() {
  const el = document.getElementById('freshnessBanner');
  if (!el) return;
  try {
    const f = await fetchJSON('/api/freshness');
    el.textContent =
      `Data: SEC N-PORT bulk through ${f.latestBulkQuarter || '—'}, EDGAR catch-up through filings of ${f.newestFilingDate || '—'}` +
      ` · newest mark date ${f.newestReportDate || '—'} (still being filed: funds file about 60 days after each report date)` +
      ` · refreshed ${f.refreshedAt ? f.refreshedAt.slice(0, 16).replace('T', ' ') + ' UTC' : '—'}`;
  } catch {
    el.textContent = '';
  }
}
loadFreshness();

// ── Tracked dashboard ──
let trackedState = null;
async function loadTracked() {
  const box = document.getElementById('trackedContainer');
  if (!box) return;
  box.innerHTML = '<div class="hint">Loading from the warehouse…</div>';
  try {
    trackedState = { data: await fetchJSON('/api/market/tracked'), sort: 'value', dir: -1 };
    renderTracked();
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}
const TRACKED_COLUMNS = [
  ['name', 'Company', r => companyLink(r.companyId, r.name), false],
  ['funds', 'Funds', r => `${fmtNum(r.funds)} <span class="fund-meta">(${fmtNum(r.fundsYearAgo)})</span>`, true],
  ['holderChange', 'Holder change', r => (r.holderChange > 0 ? '+' : '') + fmtNum(r.holderChange), true],
  ['value', 'Value', r => fmtCompactCurrency(r.value), true],
  [
    'markChange12mPct',
    '12-mo mark change',
    r =>
      `${pctText(r.markChange12mPct)} <span class="fund-meta">${r.markChangeFunds ? `(${fmtNum(r.markChangeFunds)} series)` : ''}</span>`,
    true,
  ],
  [
    'median',
    'Most-held class mark',
    r =>
      r.median == null
        ? '—'
        : `${esc(r.mainClass)} ${fmtCurrency(r.median)} <span class="fund-meta">${esc(r.markDate || '')}</span>`,
    true,
  ],
  ['dispersionPct', 'Spread', r => pctText(r.dispersionPct, 2), true],
  ['staleFunds', 'Stale marks', r => fmtNum(r.staleFunds), true],
];
function sortTracked(key) {
  trackedState.dir = trackedState.sort === key ? -trackedState.dir : -1;
  trackedState.sort = key;
  renderTracked();
}
function renderTracked() {
  const { data, sort, dir } = trackedState;
  const rows = [...data.companies].sort((a, b) => {
    const x = a[sort];
    const y = b[sort];
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
  });
  document.getElementById('trackedContainer').innerHTML =
    `<div class="hint">As of ${esc(data.date)}; a year earlier is ${esc(data.yearAgo)}. Click a column to sort.</div>
    <div class="table-wrap"><table><thead><tr>${TRACKED_COLUMNS.map(
      ([k, label, , right]) =>
        `<th class="sortable${right ? ' right' : ''}" onclick="sortTracked('${k}')">${esc(label)}${sort === k ? (dir < 0 ? ' ▼' : ' ▲') : ''}</th>`
    ).join('')}</tr></thead><tbody>${rows
      .map(
        r =>
          `<tr>${TRACKED_COLUMNS.map(([, , cell, right]) => `<td${right ? ' class="right"' : ''}>${cell(r)}</td>`).join('')}</tr>`
      )
      .join('')}</tbody></table></div>
    <button class="btn btn-green" onclick="exportCsv('tracked companies ' + trackedState.data.date, [['Company', r => r.name], ['Company Id', r => r.companyId], ['Funds', r => r.funds], ['Funds Year Ago', r => r.fundsYearAgo], ['Value USD', r => r.value], ['Value Year Ago', r => r.valueYearAgo], ['12m Mark Change %', r => r.markChange12mPct ?? ''], ['Series', r => r.markChangeFunds], ['Most-Held Class', r => r.mainClass], ['Median Mark', r => r.median ?? ''], ['Mark Date', r => r.markDate], ['Spread %', r => r.dispersionPct ?? ''], ['Stale Marks', r => r.staleFunds], ['As Of', () => trackedState.data.date], ['Source', () => 'SEC N-PORT (warehouse)']], trackedState.data.companies)">Export CSV</button>`;
}

// ── Market tab ─────────────────────────────────────────────────────────────
let marketState = null;

async function loadMarket() {
  const date = document.getElementById('marketDate')?.value || '';
  const tracked = document.getElementById('marketTracked')?.checked;
  const box = document.getElementById('marketContainer');
  box.innerHTML = '<div class="hint">Loading from the warehouse…</div>';
  try {
    const q = new URLSearchParams();
    if (date) q.set('date', date);
    if (tracked) q.set('tracked', '1');
    q.set('limit', '300');
    const [top, countries] = await Promise.all([
      fetchJSON(`/api/market/top?${q}`),
      fetchJSON(`/api/market/countries?${date ? 'date=' + enc(date) : ''}`),
    ]);
    marketState = { top, countries };
    if (!date) document.getElementById('marketDate').value = top.date;
    box.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Private companies held</div><div class="stat-value">${fmtNum(top.companies)}</div></div>
        <div class="stat-card"><div class="stat-label">Value held by funds</div><div class="stat-value highlight">${fmtCompactCurrency(top.totalValue)}</div></div>
        <div class="stat-card"><div class="stat-label">As of</div><div class="stat-value sm">${esc(top.date)}</div></div>
      </div>
      <div class="hint">Every fund counts at its latest filing on or before ${esc(top.date)} (none older than 123 days), at its own mark date. Reviewed private companies only.</div>
      <div class="table-wrap"><table><thead><tr><th class="right">#</th><th>Company</th><th class="right">Funds</th><th class="right">Value</th><th class="right">Of which indirect</th><th>Mark dates</th></tr></thead><tbody>${top.results
        .map(
          r =>
            `<tr><td class="right">${r.rank}</td><td>${companyLink(r.companyId, r.name)}${r.tracked ? ' ' + badge('Tracked') : ''}</td><td class="right">${fmtNum(r.funds)}</td><td class="right">${fmtCompactCurrency(r.value)}</td><td class="right">${r.indirectValue ? fmtCompactCurrency(r.indirectValue) : '—'}</td><td>${esc(r.oldestMark)} – ${esc(r.newestMark)}</td></tr>`
        )
        .join('')}</tbody></table></div>
      <button class="btn btn-green" onclick="exportCsv('private companies ' + marketState.top.date, [['Rank', r => r.rank], ['Company', r => r.name], ['Company Id', r => r.companyId], ['Tracked', r => (r.tracked ? 'Y' : 'N')], ['Funds', r => r.funds], ['Value USD', r => r.value], ['Indirect USD', r => r.indirectValue], ['Oldest Mark Date', r => r.oldestMark], ['Newest Mark Date', r => r.newestMark], ['As Of', () => marketState.top.date], ['Source', () => 'SEC N-PORT (warehouse)']], marketState.top.results)">Export CSV</button>
      <h3>By issuer country</h3>
      <div class="table-wrap"><table><thead><tr><th>Country</th><th class="right">Companies</th><th class="right">Funds</th><th class="right">Value</th></tr></thead><tbody>${countries.results
        .map(
          r =>
            `<tr><td>${esc(r.country)}</td><td class="right">${fmtNum(r.companies)}</td><td class="right">${fmtNum(r.funds)}</td><td class="right">${fmtCompactCurrency(r.value)}</td></tr>`
        )
        .join('')}</tbody></table></div>`;
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

let feedState = null;
async function loadFeed() {
  const since = document.getElementById('feedSince')?.value || '';
  const all = document.getElementById('feedAll')?.checked;
  const box = document.getElementById('feedContainer');
  box.innerHTML = '<div class="hint">Loading from the warehouse…</div>';
  try {
    const q = new URLSearchParams();
    if (since) q.set('since', since);
    if (all) q.set('all', '1');
    feedState = await fetchJSON(`/api/feed?${q}`);
    if (!since) document.getElementById('feedSince').value = feedState.since;
    renderFeed();
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

// The feed's rows under the chosen filter (position changes first by default).
const FEED_FILTERS = {
  positions: e => e.type !== 'unchanged',
  new: e => e.type === 'new',
  exited: e => e.type === 'exited' || e.type === 'zeroed',
  marks: e => e.markChangePct != null && Math.abs(e.markChangePct) > 0.05,
  all: () => true,
};
function renderFeed() {
  const filter = document.getElementById('feedFilter')?.value || 'positions';
  const rows = feedState.events.filter(FEED_FILTERS[filter]);
  const moves = feedState.events.filter(FEED_FILTERS.positions).length;
  document.getElementById('feedContainer').innerHTML =
    `<div class="hint">Filings made ${esc(feedState.since)} to ${esc(feedState.until)} · ${esc(feedState.scope)} · ${fmtNum(feedState.count)} changes: ${fmtNum(moves)} position changes, ${fmtNum(feedState.count - moves)} mark moves only.</div>
    <div class="search-row">
      <div class="input-group narrow"><label for="feedFilter">Show</label><select id="feedFilter" onchange="renderFeed()">${[
        ['positions', 'Position changes'],
        ['new', 'New holders'],
        ['exited', 'No longer reported / $0'],
        ['marks', 'Mark moves'],
        ['all', 'Everything'],
      ]
        .map(([v, t]) => `<option value="${v}"${v === filter ? ' selected' : ''}>${t}</option>`)
        .join('')}</select></div>
      <button class="btn btn-green" onclick="exportCsv('whats new ' + feedState.since, CHANGE_COLUMNS, feedState.events)">Export CSV</button>
    </div>
    ${changesTableHTML(rows.slice(0, 400), { withCompany: true })}
    ${rows.length > 400 ? `<div class="hint">Showing 400 of ${fmtNum(rows.length)}; the CSV has every change.</div>` : ''}`;
}

// ── Firms tab ──────────────────────────────────────────────────────────────
let firmsState = null;
let firmState = null;

async function loadFirms() {
  const box = document.getElementById('firmsContainer');
  box.innerHTML = '<div class="hint">Loading from the warehouse…</div>';
  try {
    const q = document.getElementById('firmQuery')?.value.trim() || '';
    firmsState = await fetchJSON(`/api/firms?${q ? 'q=' + enc(q) : ''}`);
    const list = firmsState.results.filter(f => f.value > 0 || q);
    box.innerHTML = `<div class="hint">Firms by the private-company value their funds hold as of ${esc(firmsState.date)}. A fund belongs to the firm that advises it (Form N-CEN); sub-advised funds are listed apart.</div>
      <div class="table-wrap"><table><thead><tr><th>Firm</th><th class="right">Funds holding private companies</th><th class="right">Funds advised</th><th class="right">Companies</th><th class="right">Value</th></tr></thead><tbody>${list
        .slice(0, 300)
        .map(
          f =>
            `<tr><td>${firmLink(f.id, f.name)}</td><td class="right">${fmtNum(f.fundsHolding)}</td><td class="right">${fmtNum(f.fundsManaged)}</td><td class="right">${fmtNum(f.companies)}</td><td class="right">${fmtCompactCurrency(f.value)}</td></tr>`
        )
        .join('')}</tbody></table></div>`;
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

async function openFirm(id, { date } = {}) {
  if (!document.getElementById('firmsTab').classList.contains('active')) switchTab('firms', { skipUrlReset: true });
  const box = document.getElementById('firmsContainer');
  box.innerHTML = '<div class="hint">Loading from the warehouse…</div>';
  try {
    const book = await fetchJSON(`/api/firms/${enc(id)}${date ? '?date=' + enc(date) : ''}`);
    firmState = { id, book };
    window.history.replaceState({}, '', `/firm/${enc(id)}${date ? '?date=' + enc(date) : ''}`);
    renderFirm();
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

function renderFirm() {
  const b = firmState.book;
  document.getElementById('firmsContainer').innerHTML = `
    <div class="company-head"><h2>${esc(b.firm.name)}</h2>
      <div class="fund-meta">${fmtNum(b.firm.fundsManaged)} funds advised, ${fmtNum(b.firm.fundsSubadvised)} sub-advised (Form N-CEN). <a href="#" onclick="loadFirms();return false;">All firms</a></div></div>
    <div class="search-row">
      <div class="input-group narrow"><label for="firmDate">Book as of</label><input type="date" id="firmDate" value="${esc(b.date)}"></div>
      <button class="btn btn-primary" onclick="openFirm(firmState.id, { date: document.getElementById('firmDate').value })">Update</button>
      <button class="btn btn-secondary" onclick="loadFirmChanges()">Position changes (12 months)</button>
      <button class="btn btn-green" onclick="exportFirmBook()">Export CSV</button>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Private companies</div><div class="stat-value">${fmtNum(b.companies)}</div></div>
      <div class="stat-card"><div class="stat-label">Value</div><div class="stat-value highlight">${fmtCompactCurrency(b.value)}</div></div>
      <div class="stat-card"><div class="stat-label">Funds holding</div><div class="stat-value">${fmtNum(b.byFund.length)}</div></div>
    </div>
    <div id="firmChangesBox"></div>
    <h3>By company</h3>
    <div class="table-wrap"><table><thead><tr><th>Company</th><th class="right">Funds</th><th class="right">Value</th><th>Positions (fund · class · shares @ mark · mark date)</th><th>Marks</th></tr></thead><tbody>${b.byCompany
      .map(
        c => `<tr><td>${companyLink(c.companyId, c.name)}${c.tracked ? ' ' + badge('Tracked') : ''}</td><td class="right">${fmtNum(c.funds)}</td><td class="right">${fmtCompactCurrency(c.value)}</td>
        <td>${c.positions
          .slice(0, 6)
          .map(
            p =>
              `<div>${esc(p.fund)} · ${esc(p.instrument || '')} · ${sharesText(p.balance)} @ ${priceText(p.pricePerShare ?? p.pricePerUnit, p.pricePerShare != null)} · ${esc(p.markDate)} ${accessionLink(p.cik, p.accession)}</div>`
          )
          .join(
            ''
          )}${c.positions.length > 6 ? `<div class="fund-meta">+${c.positions.length - 6} more (in the CSV)</div>` : ''}</td>
        <td><a href="#" onclick="loadFirmMarks(${Number(c.companyId)}, ${esc(JSON.stringify(c.name))});return false;">History</a></td></tr>`
      )
      .join('')}</tbody></table></div>
    <h3>By fund</h3>
    <div class="table-wrap"><table><thead><tr><th>Fund</th><th>Mark date</th><th class="right">Companies</th><th class="right">Private value</th><th class="right">% of net assets</th><th>Filing</th></tr></thead><tbody>${b.byFund
      .map(
        f =>
          `<tr><td>${fundLink(f.fundKey, f.label)}</td><td>${esc(f.markDate)}</td><td class="right">${fmtNum(f.companies)}</td><td class="right">${fmtCompactCurrency(f.value)}</td><td class="right">${f.netAssets ? ((f.value / f.netAssets) * 100).toFixed(2) + '%' : '—'}</td><td>${accessionLink(f.cik, f.accession)}</td></tr>`
      )
      .join('')}</tbody></table></div>`;
}

function exportFirmBook() {
  const b = firmState.book;
  const rows = b.byCompany.flatMap(c => c.positions.map(p => ({ ...p, company: c.name, companyId: c.companyId })));
  exportCsv(
    `${b.firm.name} book ${b.date}`,
    [
      ['Company', r => r.company],
      ['Company Id', r => r.companyId],
      ['Fund', r => r.fund],
      ['Fund Key', r => r.fundKey],
      ['Class', r => r.instrument],
      ['Shares or Units', r => r.balance],
      ['Unit', r => r.unit],
      ['Price Per Share', r => r.pricePerShare ?? ''],
      ['Price Per Unit', r => r.pricePerUnit ?? ''],
      ['Value USD', r => r.value],
      ['% of NAV', r => r.pctNav],
      ['Mark Date', r => r.markDate],
      ['Accession', r => r.accession],
      ['As Of', () => b.date],
      ['Source', () => 'SEC N-PORT (warehouse)'],
    ],
    rows
  );
}

async function loadFirmChanges() {
  const box = document.getElementById('firmChangesBox');
  box.innerHTML = '<div class="hint">Loading…</div>';
  try {
    const r = await fetchJSON(`/api/firms/${enc(firmState.id)}/changes`);
    firmState.changes = r;
    const moves = r.events.filter(e => e.type !== 'unchanged');
    box.innerHTML = `<h3>Position changes, ${esc(r.since)} to ${esc(r.until)} (mark dates)</h3>
      <div class="hint">${fmtNum(moves.length)} position changes and ${fmtNum(r.events.length - moves.length)} mark moves across the firm's funds.</div>
      <button class="btn btn-green" onclick="exportCsv(firmState.book.firm.name + ' changes', CHANGE_COLUMNS, firmState.changes.events)">Export CSV</button>
      ${changesTableHTML(r.events.slice(0, 400), { withCompany: true })}`;
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

async function loadFirmMarks(companyId, name) {
  const box = document.getElementById('firmChangesBox');
  box.innerHTML = '<div class="hint">Loading…</div>';
  try {
    const m = await fetchJSON(`/api/firms/${enc(firmState.id)}/marks/${enc(companyId)}`);
    const classes = [...new Set(m.series.map(s => s.instrument))];
    box.innerHTML = `<h3>${esc(firmState.book.firm.name)}: ${esc(name)} marks per class</h3>
      <div class="hint">Median, low and high per-share mark across the firm's funds that filed each date; marks in ${fmtNum(m.months)} of 12 calendar months (funds on staggered calendars).</div>
      <div class="chart-wrap"><canvas id="firmMarksChart" height="100"></canvas></div>
      <div class="table-wrap"><table><thead><tr><th>Mark date</th><th>Class</th><th class="right">Funds</th><th class="right">Median</th><th class="right">Low – High</th></tr></thead><tbody>${[
        ...m.series,
      ]
        .reverse()
        .map(
          s =>
            `<tr><td>${esc(s.markDate)}</td><td>${esc(s.instrument)}</td><td class="right">${fmtNum(s.funds)}</td><td class="right">${fmtCurrency(s.median)}</td><td class="right">${fmtCurrency(s.low)} – ${fmtCurrency(s.high)}</td></tr>`
        )
        .join('')}</tbody></table></div>`;
    viewChart('firmMarksChart', {
      type: 'line',
      data: {
        datasets: classes.map(k => ({
          label: k,
          data: m.series.filter(s => s.instrument === k).map(s => ({ x: s.markDate, y: s.median })),
          pointRadius: 2,
        })),
      },
      options: { parsing: true, scales: { x: { type: 'time' }, y: { ticks: { callback: x => fmtCurrency(x) } } } },
    });
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

// ── Fund page: changes filing by filing ────────────────────────────────────
async function loadFundChanges(fundKey) {
  const box = document.getElementById('fundChangesBox');
  if (!box) return;
  box.innerHTML = '<div class="hint">Loading…</div>';
  try {
    const r = await fetchJSON(`/api/funds/${enc(fundKey)}/changes`);
    box.innerHTML = `<h3>Private-company changes, filing by filing</h3>
      <button class="btn btn-green" onclick="exportCsv('${esc(fundKey)} changes', CHANGE_COLUMNS, window.__fundChanges)">Export CSV</button>
      ${changesTableHTML(r.events.slice(0, 400), { withCompany: true, withFund: false })}`;
    window.__fundChanges = r.events;
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}
