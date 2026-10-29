// Family parsers for N-CSR / N-CSRS restricted-securities tables (Reg. S-X 12-12
// footnote: security, acquisition date, cost). Two layouts, both read from real
// filings (docs/plans/ncsr-research.md):
//
//   Fidelity: one filing for several funds. Each fund's section opens with its name
//     and "(Consolidated )Schedule of Investments <date>"; rows are name | shares |
//     value in dollars; the section ends at "NET ASSETS - 100.0%"; then the footnote
//     "the value of restricted securities ... amounted to $X or Y% of net assets" and
//     "Additional information on each restricted holding": security | acquisition
//     date | acquisition cost ($). The cost table has no value: it comes from the
//     schedule row with the same name.
//   Capital Group: one fund per filing. "Investment portfolio <date>"; rows are
//     name | shares | value in thousands; "Restricted securities": security |
//     acquisition date(s) | cost | value | percent of net assets, in thousands, with a
//     "Total" row; the table repeats its header on each page ("(continued)").
//
// Amounts are returned in dollars with the unit they were printed in (1 or 1000),
// so the matcher knows how close a value can be. Nothing is guessed: a row this
// code cannot read stops the parse (fails loudly) instead of being skipped.
const { htmlEvents, parseAmount, parseDateRange, parseLongDate, stripFootnotes } = require('./html');

// A security name as both tables print it, for pairing a cost row with its schedule
// row: footnote marks and Fidelity's inline "(Cost $4,471,547)" dropped.
function securityName(raw) {
  return stripFootnotes(String(raw).replace(/\s*\(Cost \$[\d,]+\)/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

const rowText = e => (e.type === 'row' ? e.cells.join(' ') : e.text);

// "0.40 %", "0.00 (p)", "0.23" → 0.40 / 0 / 0.23 (percent of net assets); null otherwise.
function parsePct(s) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*%?\s*(?:\([a-z]\))?\s*%?$/);
  return m ? Number(m[1]) : null;
}

// Schedule rows: name | shares or principal | value. Headings (one cell) and
// subtotals ("TOTAL ...", "Total ...") are not holdings. Capital Group prints values
// in thousands ("— (h)" below one thousand) and a note's principal in thousands with
// its currency ("USD 25,314"); shares are whole shares in both families.
function scheduleRow(cells, unit) {
  if (cells.length !== 3) return null;
  const [name, a, b] = cells;
  if (/^total\b/i.test(name) || parseAmount(name) !== null) return null;
  const principal = unit === 1000 && a.match(/^[A-Z]{3}\s+(.+)$/);
  const shares = principal ? parseAmount(principal[1]) : parseAmount(a);
  const value = unit === 1000 ? thousands(b) : { amount: parseAmount(b), belowUnit: false };
  if (shares === null || !value || value.amount === null) return null;
  const marks = [...name.matchAll(/\(([a-z]{1,2})\)/g)].map(m => m[1]);
  return {
    rawName: name,
    name: securityName(name),
    shares: principal ? shares * 1000 : shares,
    value: value.amount * unit,
    belowUnit: value.belowUnit,
    marks,
  };
}

// The footnote row "(e) | Restricted securities ... amounted to $X or Y% of net assets.": its
// letter marks the restricted rows in the schedule, its total checks the table.
function restrictedFootnote(e) {
  if (e.type !== 'row' || e.cells.length !== 2) return null;
  const mark = e.cells[0].match(/^\(([a-z]{1,2})\)$/);
  const m =
    mark &&
    e.cells[1].match(
      /value of restricted securities \(excluding 144A issues\) amounted to \$([\d,]+) or ([\d.]+)% of net assets/
    );
  return m ? { mark: mark[1], value: parseAmount(m[1]), pctNav: Number(m[2]) } : null;
}

function parseFidelity(html) {
  const events = htmlEvents(html);
  const starts = [];
  events.forEach((e, i) => {
    if (e.type !== 'text') return;
    const m = e.text.match(/^(?:Consolidated )?Schedule of Investments (\w+ \d{1,2}, \d{4})/);
    if (m && i > 0 && events[i - 1].type === 'text') starts.push({ i, fundName: events[i - 1].text, date: m[1] });
  });
  if (!starts.length) throw new Error('Fidelity N-CSR: no "Schedule of Investments" section found');
  return starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].i : events.length;
    const section = events.slice(s.i + 1, end);
    const fund = {
      fundName: s.fundName.replace(/[®™]/g, '').replace(/\s+/g, ' ').trim(),
      periodEnd: parseLongDate(s.date),
      unit: 1,
      netAssets: null,
      schedule: [],
      restricted: [],
      restrictedTotal: null,
    };
    let j = 0;
    for (; j < section.length; j++) {
      const e = section[j];
      if (e.type !== 'row') continue;
      const na = e.cells.length === 2 && /^NET ASSETS - 100\.0%$/.test(e.cells[0]) ? parseAmount(e.cells[1]) : null;
      if (na !== null) {
        fund.netAssets = na;
        break;
      }
      const r = scheduleRow(e.cells, 1);
      if (r) fund.schedule.push(r);
    }
    if (fund.netAssets === null) throw new Error(`Fidelity N-CSR: ${fund.fundName}: no "NET ASSETS - 100.0%" row`);
    for (; j < section.length; j++) {
      const total = restrictedFootnote(section[j]);
      if (total) fund.restrictedTotal = total;
      if (/^Additional information on each restricted holding/.test(rowText(section[j]))) break;
    }
    if (j >= section.length) return fund; // a fund with no restricted holdings
    for (j++; j < section.length; j++) {
      const { type, cells } = section[j];
      if (type !== 'row') break;
      if (cells.join(' | ') === 'Security | Acquisition Date | Acquisition Cost ($)') continue;
      const dates = cells.length === 3 ? parseDateRange(cells[1]) : null;
      const cost = cells.length === 3 ? parseAmount(cells[2]) : null;
      if (!dates || cost === null) break;
      fund.restricted.push({
        rawName: cells[0],
        name: securityName(cells[0]),
        acquiredFirst: dates.first,
        acquiredLast: dates.last,
        cost,
        value: null,
        belowUnit: false,
        pctNav: null,
      });
    }
    if (!fund.restricted.length) throw new Error(`Fidelity N-CSR: ${fund.fundName}: restricted table has no rows`);
    return fund;
  });
}

// A Capital Group amount in thousands: "1,315,269", "$ 97,662", or "— (h)" for an amount
// below one thousand (footnoted "Amount less than one thousand").
function thousands(cell) {
  if (/^—\s*(\([a-z]{1,2}\))?$/.test(cell)) return { amount: 0, belowUnit: true };
  const amount = parseAmount(cell);
  return amount === null ? null : { amount, belowUnit: false };
}

function parseCapitalGroup(html) {
  const events = htmlEvents(html);
  const start = events.findIndex(e => e.type === 'text' && /^Investment portfolio \w+ \d{1,2}, \d{4}/.test(e.text));
  if (start < 0) throw new Error('Capital Group N-CSR: no "Investment portfolio <date>" heading');
  if (events.slice(start + 1).some(e => e.type === 'text' && /^Investment portfolio \w+ \d{1,2}, \d{4}/.test(e.text)))
    throw new Error('Capital Group N-CSR: more than one investment portfolio (multi-fund filings are not supported)');
  const fund = {
    fundName: null, // one fund per filing: the filing header names the series
    periodEnd: parseLongDate(events[start].text),
    unit: 1000,
    netAssets: null,
    schedule: [],
    restricted: [],
    restrictedTotal: null,
  };
  let j = start + 1;
  for (; j < events.length; j++) {
    const e = events[j];
    if (e.type !== 'row') continue;
    if (e.cells.length === 2 && /^Net assets 100\.00%$/.test(e.cells[0])) {
      fund.netAssets = parseAmount(e.cells[1]) * 1000;
      break;
    }
    const r = scheduleRow(e.cells, 1000);
    if (r) fund.schedule.push(r);
  }
  if (fund.netAssets === null) throw new Error('Capital Group N-CSR: no "Net assets 100.00%" row');
  const header = 'Acquisition date(s) | Cost (000) | Value (000) | Percent of net assets';
  const first = events.findIndex((e, i) => i > j && e.type === 'text' && /^Restricted securities\b/.test(e.text));
  if (first < 0) return [fund]; // no restricted holdings
  // "Restricted securities (c)": the letter that marks restricted rows in the portfolio
  const mark = (events[first].text.match(/^Restricted securities \(([a-z]{1,2})\)/) || [])[1] || null;
  for (let k = first + 1; k < events.length; k++) {
    const e = events[k];
    if (e.type === 'text') {
      if (/^Restricted securities\b.*\(continued\)/.test(e.text)) continue;
      break;
    }
    const line = e.cells.join(' | ');
    if (line === header) continue;
    if (e.cells[0] === 'Total') {
      fund.restrictedTotal = {
        mark,
        cost: parseAmount(e.cells[1]) * 1000,
        value: parseAmount(e.cells[2]) * 1000,
        pctNav: parsePct(e.cells[3]),
      };
      break;
    }
    // a page footer inside the table: "<fund name> | 8" or "21 | <fund name>"
    if (e.cells.length === 2 && e.cells.some(c => /^\d+$/.test(c))) continue;
    const dates = e.cells.length === 5 ? parseDateRange(e.cells[1]) : null;
    const cost = dates ? thousands(e.cells[2]) : null;
    const value = dates ? thousands(e.cells[3]) : null;
    if (!dates || cost === null || value === null)
      throw new Error(`Capital Group N-CSR: unreadable restricted row: ${line.slice(0, 160)}`);
    fund.restricted.push({
      rawName: e.cells[0],
      name: securityName(e.cells[0]),
      acquiredFirst: dates.first,
      acquiredLast: dates.last,
      cost: cost.amount * 1000,
      value: value.amount * 1000,
      // "—" (amount less than one thousand): the true amount is 0 to 999 dollars
      belowUnit: cost.belowUnit || value.belowUnit,
      pctNav: parsePct(e.cells[4]),
    });
  }
  if (!fund.restrictedTotal) throw new Error('Capital Group N-CSR: restricted table has no "Total" row');
  return [fund];
}

const PARSERS = { fidelity: parseFidelity, capital: parseCapitalGroup };

function parseNcsr(html, family) {
  const parse = PARSERS[family];
  if (!parse) throw new Error(`unknown N-CSR family: ${family}`);
  return parse(html);
}

module.exports = {
  parseNcsr,
  parseFidelity,
  parseCapitalGroup,
  scheduleRow,
  restrictedFootnote,
  securityName,
  parsePct,
  thousands,
  FAMILIES: Object.keys(PARSERS),
};
