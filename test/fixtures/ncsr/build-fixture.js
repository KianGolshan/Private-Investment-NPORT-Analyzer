#!/usr/bin/env node
// Rebuilds test/fixtures/ncsr/ from REAL SEC filings and the local warehouse:
//
//   node test/fixtures/ncsr/build-fixture.js [cacheDir]   # default reports/ncsr/sample/cache (the pilot's)
//
// For each N-CSR in FILINGS it keeps, in document order, the events the parsers read:
// the section headings, every row carrying the restricted mark plus the first few other
// schedule rows, the net-assets row, the footnotes and the whole restricted table (page
// footers and "(continued)" headers included). `whole` keeps a fund's events from its
// report cover (or heading) to the end of its cost table unchanged: the older layouts,
// whose issuer lines, unit headers and split cells the parsers must read. `textChunks`
// (T. Rowe Price, laid out in positioned text) keeps the sentences and restricted lines
// the parser reads. Cell text is the filer's, re-emitted as plain <table><tr><td> markup. RAW keeps a short verbatim slice of each family's markup
// for the HTML reader. HOLDINGS copies the warehouse's N-PORT rows for the same fund and
// date that the matcher needs. Documents missing from the cache are fetched through the
// paced SEC client (needs SEC_USER_AGENT). Nothing is hand-written.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { secGet } = require('../../../lib/warehouse/delta');
const { openWarehouseReadOnly } = require('../../../lib/warehouse/db');
const { htmlEvents } = require('../../../lib/ncsr/html');
const { scheduleRow, restrictedFootnote, TROWE_ROW } = require('../../../lib/ncsr/parse');

const OUT = __dirname;
const FILINGS = {
  '0000707823-26-000042': {
    cik: '707823',
    doc: 'filing12370.htm',
    family: 'fidelity',
    funds: ['Fidelity® Growth Company Fund', 'Fidelity® Growth Strategies Fund'],
    note: 'Fidelity Mt. Vernon Street Trust N-CSRS 2026-05-31: Growth Company (234 cost rows), Growth Strategies (4)',
  },
  '0001193125-26-195253': {
    cik: '44201',
    doc: '8dea0ac98b6ba57.htm',
    family: 'capital',
    note: 'Growth Fund of America N-CSRS 2026-02-28: 29 cost rows, a continued table, Stripe Class B in two N-PORT legs',
  },
  '0001193125-26-247125': {
    cik: '858744',
    doc: '8deb6d449805be9.htm',
    family: 'capital',
    note: 'SMALLCAP World Fund N-CSRS 2026-03-31: "— (h)" amounts, a note principal "USD 25,314", "21 | <fund>" footers',
  },  '0001379491-21-003390': {
    cik: '707823',
    doc: 'filing936.htm',
    family: 'fidelity',
    whole: ['Fidelity® New Millennium Fund®'],
    note: 'Fidelity N-CSRS 2021-05-31, New Millennium: values in (000s), "Allbirds, Inc.:" issuer lines, footnotes as paragraphs, two-digit years, "(Cost $8,368)" on its own line',
  },
  '0000051931-22-001052': {
    cik: '44201',
    doc: 'gfa_ncsr.htm',
    family: 'capital',
    whole: true,
    note: 'Growth Fund of America N-CSR 2022-08-31: numeric marks "1,2,5", "$ | 142,918" split cells, a header over three rows',
  },
  '0001193125-26-062850': {
    cik: '819930',
    doc: null,
    family: 'troweprice',
    textChunks: true,
    note: 'T. Rowe Price Science & Technology N-CSR 2025-12-31: costs inline, a blank cost ("Cost $") and a blank value',
  },
  '0001104659-26-104596': {
    cik: '836487',
    doc: null,
    family: 'morganstanley',
    whole: ['Growth Portfolio', 'Inception Portfolio'],
    note: 'Morgan Stanley Institutional Fund N-CSRS 2026-06-30: "(acquisition cost — $63,187; acquired 8/31/21)"; Inception has two restricted rows without a cost',
  },
};
// N-PORT filings for the same fund and date (canonical_filings)
const HOLDINGS = {
  '0000035402-26-004656': 'Fidelity Growth Company Fund (S000007119) 2026-05-31',
  '0000035402-26-004657': 'Fidelity Growth Strategies Fund (S000007118) 2026-05-31',
  '0001193125-26-182055': 'Growth Fund of America (S000009228) 2026-02-28',
  '0001193125-26-243462': 'SMALLCAP World Fund (S000009599) 2026-03-31',
  '0001752724-21-152583': 'Fidelity New Millennium Fund (S000007120) 2021-05-31',
  '0001145549-22-063355': 'Growth Fund of America (S000009228) 2022-08-31',
  '0001099263-26-002527': 'T. Rowe Price Science & Technology Fund (S000002119) 2025-12-31',
  '0001410368-26-084089': 'Morgan Stanley Growth Portfolio (S000002828) 2026-06-30',
  '0001410368-26-084068': 'Morgan Stanley Inception Portfolio (S000002825) 2026-06-30',
};
const OTHER_ROWS = 3; // unmarked schedule rows kept per fund (the parser must skip them for the cost table)

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const emit = e =>
  e.type === 'text' ? `<div>${esc(e.text)}</div>` : `<tr>${e.cells.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`;

function render(events) {
  const out = [];
  let inTable = false;
  for (const e of events) {
    if (e.type === 'row' && !inTable) out.push('<table>');
    if (e.type === 'text' && inTable) out.push('</table>');
    inTable = e.type === 'row';
    out.push(emit(e));
  }
  if (inTable) out.push('</table>');
  return `<html><body>\n${out.join('\n')}\n</body></html>\n`;
}

// The events of one fund section the parsers read, `start` at its "Schedule of Investments"
// (Fidelity) or "Investment portfolio" (Capital Group) heading, `end` exclusive.
function keepSection(events, start, end, family) {
  const keep = [events[start - 1], events[start]];
  const unit = family === 'capital' ? 1000 : 1;
  const netAssets = family === 'capital' ? /^Net assets 100\.00%$/ : /^NET ASSETS - 100\.0%$/;
  let mark = null;
  for (let i = start + 1; i < end; i++) {
    const e = events[i];
    const f = restrictedFootnote(e);
    if (f) mark = f.mark;
    const m = e.type === 'text' && e.text.match(/^Restricted securities \(([a-z]{1,2})\)$/);
    if (m) mark = m[1];
  }
  if (!mark) throw new Error(`no restricted mark in section at event ${start}`);
  let others = 0;
  let i = start + 1;
  for (; i < end; i++) {
    const e = events[i];
    if (e.type === 'row' && e.cells.length === 2 && netAssets.test(e.cells[0])) {
      keep.push(e);
      break;
    }
    const r = e.type === 'row' ? scheduleRow(e.cells, unit) : null;
    if (r && r.marks.includes(mark)) keep.push(e);
    else if (r && others < OTHER_ROWS) {
      keep.push(e);
      others++;
    } else if (e.type === 'row' && e.cells.length === 1 && others < OTHER_ROWS) keep.push(e); // headings
  }
  // footnotes and the restricted table, verbatim in order
  const tableStart =
    family === 'capital'
      ? events.findIndex((e, k) => k > i && e.type === 'text' && /^Restricted securities \(/.test(e.text))
      : events.findIndex(
          (e, k) => k > i && e.type === 'row' && /^Additional information on each restricted/.test(e.cells[0])
        );
  for (let k = i + 1; k < tableStart; k++) if (restrictedFootnote(events[k])) keep.push(events[k]);
  for (let k = tableStart; k < end; k++) {
    const e = events[k];
    keep.push(e);
    if (family === 'capital' && e.type === 'row' && e.cells[0] === 'Total') break;
    if (family === 'fidelity' && k > tableStart + 1 && (e.type !== 'row' || e.cells.length !== 3)) break;
  }
  return keep;
}

async function documentOf(cacheDir, accession, { cik, doc }) {
  const file = path.join(cacheDir, `${accession}.htm`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  if (!doc) throw new Error(`${accession}: not in ${cacheDir}; run scripts/ncsr-pilot.js first`);
  return String(await secGet(`https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/${doc}`));
}

async function main() {
  const cacheDir = process.argv[2] || path.join(__dirname, '../../../reports/ncsr/sample/cache');
  const built = {};
  const raw = new Set();
  for (const [accession, f] of Object.entries(FILINGS)) {
    const html = await documentOf(cacheDir, accession, f);
    const events = htmlEvents(html);
    let kept = [];
    if (f.textChunks) {
      // the statement heading, NET ASSETS, the restricted footnotes and every restricted line, verbatim
      const text = events.map(e => (e.type === 'row' ? e.cells.join(' | ') : e.text)).join(' ');
      const pick = [
        /\w+ \d{1,2}, \d{4}(?: \(?Unaudited\)?)? Statement of Assets and Liabilities/,
        /NET ASSETS \$ [\d,]+\u200c/,
        /\(\d{1,2}\) Security cannot be offered for public resale[^.]*\./,
        /The aggregate value of restricted securities[^%]*%/,
      ].map(re => (text.match(re) || [''])[0]);
      const lines = [...text.matchAll(TROWE_ROW)].map(m => m[0]);
      kept = [...pick, ...lines].filter(Boolean).map(t => ({ type: 'text', text: t }));
    } else if (f.whole && f.family === 'morganstanley') {
      const starts = events
        .map((e, i) => (e.type === 'text' && /^(?:Consolidated )?Portfolio of Investments$/.test(e.text) ? i : -1))
        .filter(i => i >= 0);
      for (const name of f.whole) {
        const s = starts.find(i => events[i + 1] && events[i + 1].text === name);
        if (s === undefined) throw new Error(`${accession}: no section for ${name}`);
        kept = kept.concat(events.slice(s, starts.find(i => i > s) || events.length));
      }
    } else if (f.whole && f.family === 'fidelity') {
      for (const name of f.whole) {
        const cover = events.findIndex(
          (e, i) => e.type === 'text' && e.text === name && /Annual Report$/.test((events[i + 1] || {}).text || '')
        );
        const table = events.findIndex(
          (e, i) =>
            i > cover && /^Additional information on each restricted/.test(e.type === 'row' ? e.cells[0] : e.text)
        );
        if (cover < 0 || table < 0) throw new Error(`${accession}: no cover or cost table for ${name}`);
        let end = table + 1;
        while (end < events.length && events[end].type === 'row') end++;
        kept = kept.concat(events.slice(cover, end));
      }
    } else if (f.whole) {
      const s = events.findIndex(e => /^(?:Summary )?[Ii]nvestment portfolio \w+ \d/.test(e.type === 'row' ? e.cells.join(' | ') : e.text));
      const total = events.findIndex((e, i) => i > s && e.type === 'row' && /^Total(?: private placement securities)?$/.test(e.cells[0]) && e.cells.length >= 4);
      kept = events.slice(s, total + 1);
    } else if (f.family === 'fidelity') {
      const starts = events
        .map((e, i) => ({ e, i }))
        .filter(({ e, i }) => e.type === 'text' && /^(?:Consolidated )?Schedule of Investments \w+ \d/.test(e.text) && i)
        .map(({ i }) => i);
      for (const name of f.funds) {
        const s = starts.find(i => events[i - 1].text === name);
        if (s === undefined) throw new Error(`${accession}: no section for ${name}`);
        kept = kept.concat(keepSection(events, s, starts.find(i => i > s) || events.length, 'fidelity'));
      }
    } else {
      const s = events.findIndex(e => e.type === 'text' && /^Investment portfolio \w+ \d/.test(e.text));
      kept = keepSection(events, s, events.length, 'capital');
    }
    fs.writeFileSync(path.join(OUT, `${accession}.html`), render(kept));
    built[accession] = { ...f, events: kept.length };
    // a verbatim slice of the filer's markup around the restricted table, for the HTML reader
    const anchor = f.family === 'fidelity' ? 'Additional information on each restricted holding' : 'Anthropic, PBC, Class G-1';
    // the restricted table's own row (Capital Group prints the name in the portfolio first)
    const at = html.indexOf(anchor, f.family === 'capital' ? html.indexOf('Restricted securities') : 0);
    if (at >= 0 && !raw.has(f.family) && !f.whole && !f.textChunks) {
      raw.add(f.family);
      const from = html.lastIndexOf('<tr', at);
      let to = from;
      for (let n = 0; n < 4; n++) to = html.indexOf('</tr>', to) + 5;
      fs.writeFileSync(path.join(OUT, `raw-${f.family}.html`), `<table>${html.slice(from, to)}</table>\n`);
    }
  }
  const db = openWarehouseReadOnly();
  const holdings = {};
  try {
    for (const accession of Object.keys(HOLDINGS))
      holdings[accession] = db
        .prepare(
          `SELECT h.row_key, h.issuer_name, h.title, h.balance, h.value_usd, h.company_id,
                  c.name AS company_name, c.category, c.status
           FROM holdings h LEFT JOIN companies c ON c.id = h.company_id
           WHERE h.accession = ? ORDER BY h.row_key`
        )
        .all(accession);
  } finally {
    db.close();
  }
  fs.writeFileSync(path.join(OUT, 'holdings.json'), JSON.stringify(holdings) + '\n');
  const manifest = {
    builtAt: new Date().toISOString(),
    filings: built,
    holdings: Object.fromEntries(Object.entries(HOLDINGS).map(([a, note]) => [a, { note, rows: holdings[a].length }])),
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
