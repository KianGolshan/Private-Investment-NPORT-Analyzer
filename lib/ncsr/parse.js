// Family parsers for N-CSR / N-CSRS restricted-securities tables (Reg. S-X 12-12
// footnote: security, acquisition date, cost). Four families, each read from real
// filings (Fidelity and Capital Group back to 2020; docs/plans/ncsr-research.md):
//
//   Fidelity: one filing for several funds. Each fund's section opens with
//     "(Consolidated )Schedule of Investments <date>"; its name is on the report cover
//     ("<fund> / Semi-Annual Report") or, since 2024, right above the heading. Rows are
//     name | shares or principal | value, in dollars or, when the column header says
//     "(000s)", in thousands (2020-2023 for the large funds); the section ends at
//     "NET ASSETS - 100%". Then the footnote "(e) Restricted securities ... amounted to
//     $X or Y% of net assets" (a row since 2023, a paragraph before) and "Additional
//     information on each restricted holding": security | acquisition date | acquisition
//     cost ($ or 000s). The cost table has no value: it comes from the schedule row with
//     the same name.
//   Capital Group: one fund per filing. "(Summary) Investment portfolio <date>" (a
//     paragraph or a table row); rows are name | shares | value in thousands; then
//     "Restricted securities" (2021: "Private placement securities"): security |
//     acquisition date(s) | cost | value | percent of net assets, in thousands, with a
//     "Total" row; the table repeats its header on each page ("(continued)"). Footnote
//     marks are letters ("(a)(b)") or, before 2026, numbers ("1,4"). A summary portfolio
//     (2020) lists the private holdings after the net-assets line.
//   T. Rowe Price: one fund per filing, laid out in positioned text, not tables. Each
//     restricted line carries its cost: "Databricks, Series J, Acquisition Date: 12/17/24,
//     Cost $1,974 (1)(3)(4) 21,342 4,754" (cost and value in $000s); the footnote states
//     "the aggregate value of restricted securities ... amounts to $1,899,396".
//   Morgan Stanley: one filing for many portfolios ("Portfolio of Investments" / "<name>
//     Portfolio"); a restricted row carries "(acquisition cost — $63,187; acquired 8/31/21)"
//     in its name cell, values in $000s; no stated restricted total.
//
// Amounts are returned in dollars with the unit they were printed in (1 or 1000),
// so the matcher knows how close a value can be. Nothing is guessed: a row this
// code cannot read stops the parse (fails loudly) instead of being skipped.
const { htmlEvents, parseAmount, parseDateRange, parseLongDate, stripFootnotes } = require('./html');

// A security name as both tables print it, for pairing a cost row with its schedule
// row: footnote marks, Fidelity's inline "(Cost $4,471,547)" and, where the filer marks
// with numbers, a trailing "1,4" dropped.
function securityName(raw, numericMarks = false) {
  let s = String(raw).replace(/\s*\(Cost \$[\d,]+\)/g, '');
  if (numericMarks) s = s.replace(/\s+\d{1,2}(?:,\s?\d{1,2})*$/, '');
  return stripFootnotes(s).replace(/\s+/g, ' ').trim();
}

const rowText = e => (e.type === 'row' ? e.cells.join(' ') : e.text);

// "0.40 %", "0.00 (p)", "0.23", ".08", ".00 16" → percent of net assets; null otherwise.
function parsePct(s) {
  const m = String(s).match(/^(\d*\.?\d+)\s*%?\s*(?:\(?[a-z]{1,2}\)?|\d{1,2})?\s*%?$/);
  return m ? Number(m[1]) : null;
}

// A Capital Group amount in thousands: "1,315,269", "$ 97,662", or "— (h)" / "— 9" / "—*" for
// an amount below one thousand (footnoted "Amount less than one thousand").
function thousands(cell) {
  if (/^[—–]\s*(?:\(?[a-z]{1,2}\)?|\d{1,2}|\*)?$/.test(cell)) return { amount: 0, belowUnit: true };
  const amount = parseAmount(cell);
  return amount === null ? null : { amount, belowUnit: false };
}

// Capital Group splits one amount over cells: "$ | 142,918", "(16,465 | )", ".06 | %".
function joinCells(cells) {
  const out = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c === '$' && i + 1 < cells.length) {
      cells[i + 1] = `$ ${cells[i + 1]}`;
      continue;
    }
    if ((c === ')' || c === '%') && out.length) {
      out[out.length - 1] += c === ')' ? ')' : ' %';
      continue;
    }
    out.push(c);
  }
  return out;
}

// Schedule rows: name | shares or principal | value. Headings (one cell) and
// subtotals ("TOTAL ...", "Total ...") are not holdings. `valueUnit` is 1 or 1000;
// `sharesUnit` is 1000 under a "Principal Amount (000s)" header. Capital Group prints
// values in thousands ("— (h)" below one thousand) and a note's principal in thousands
// with its currency ("USD 25,314").
function scheduleRow(cells, valueUnit, { sharesUnit = 1, numericMarks = false } = {}) {
  if (cells.length !== 3) return null;
  const [name, a, b] = cells;
  if (/^total\b/i.test(name) || parseAmount(name) !== null) return null;
  const principal = valueUnit === 1000 && a.match(/^[A-Z]{3}\s+(.+)$/);
  const shares = principal ? parseAmount(principal[1]) : parseAmount(a);
  const value = valueUnit === 1000 ? thousands(b) : { amount: parseAmount(b), belowUnit: false };
  if (shares === null || !value || value.amount === null) return null;
  const marks = numericMarks
    ? ((name.match(/\s(\d{1,2}(?:,\s?\d{1,2})*)$/) || [])[1] || '')
        .split(',')
        .filter(Boolean)
        .map(s => s.trim())
    : [...name.matchAll(/\(([a-z]{1,2})\)/g)].map(m => m[1]);
  return {
    rawName: name,
    name: securityName(name, numericMarks),
    shares: principal ? shares * 1000 : shares * sharesUnit,
    value: value.amount * valueUnit,
    belowUnit: value.belowUnit,
    marks,
  };
}

// The footnote "(e) Restricted securities ... amounted to $X or Y% of net assets.", a row
// ("(e) | Restricted ...") or a paragraph: its letter marks the restricted rows in the
// schedule, its total (always in dollars) checks the table.
function restrictedFootnote(e) {
  const text = e.type === 'row' ? (e.cells.length === 2 ? e.cells.join(' ') : '') : e.text;
  const m = text.match(
    /^\(([a-z]{1,2})\) Restricted securities .*value of restricted securities \(excluding 144A issues\) amounted to \$([\d,]+) or ([\d.]+)% of net assets/
  );
  return m ? { mark: m[1], value: parseAmount(m[2]), pctNav: Number(m[3]) } : null;
}

// A class line under an issuer line: "Series A (a)(b)", "Class B", "4% 5/22/27 (b)(c)", "0% (b)",
// or the second line of a long name: "(Cost $8,368) | 8,367,654 | 3,715" (Utica Shale Drilling Program, 2021).
const CLASS_LINE = /^(?:(?:Series|Class|Common|Preferred|Ordinary|Units?|Warrants?)\b|\d+(?:\.\d+)?%|\(Cost \$)/;

const FIDELITY_HEADING = /^(?:Consolidated )?Schedule of Investments (\w+ \d{1,2}, \d{4})/;
const cleanFundName = s => s.replace(/[®™]/g, '').replace(/\s+/g, ' ').trim();

// The fund a Fidelity section belongs to: the nearest report cover above it ("<fund>" then
// "Semi-Annual Report" / "Annual Report"), else the line right above the heading (2024+).
function fidelityFundName(events, i) {
  for (let k = i - 1; k > 0; k--) {
    if (FIDELITY_HEADING.test(rowText(events[k]))) break; // the previous section
    if (/^(?:Semi-)?Annual Report$/.test(rowText(events[k]))) return rowText(events[k - 1]);
  }
  return events[i - 1] && events[i - 1].type === 'text' ? events[i - 1].text : null;
}

function parseFidelity(html) {
  const events = htmlEvents(html);
  const starts = [];
  events.forEach((e, i) => {
    const m = e.type === 'text' && e.text.match(FIDELITY_HEADING);
    if (m && i > 0) starts.push({ i, fundName: fidelityFundName(events, i), date: m[1] });
  });
  if (!starts.length) throw new Error('Fidelity N-CSR: no "Schedule of Investments" section found');
  return starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].i : events.length;
    const section = events.slice(s.i + 1, end);
    if (!s.fundName) throw new Error(`Fidelity N-CSR: no fund name above the schedule at event ${s.i}`);
    const fund = {
      fundName: cleanFundName(s.fundName),
      periodEnd: parseLongDate(s.date),
      unit: 1,
      netAssets: null,
      schedule: [],
      restricted: [],
      restrictedTotal: null,
    };
    // column units follow the latest "Shares | Value ..." / "Principal Amount ... | Value ..." header
    let valueUnit = 1;
    let sharesUnit = 1;
    let issuer = null; // before 2025: "Pine Labs Private Ltd." on its own line, then "Series A (a)(b)(c) | ..."
    let j = 0;
    for (; j < section.length; j++) {
      const e = section[j];
      if (e.type !== 'row') continue;
      if (e.cells.length === 2 && /^(?:Shares|Principal Amount)\b/.test(e.cells[0]) && /^Value\b/.test(e.cells[1])) {
        valueUnit = /\(000s\)/.test(e.cells[1]) ? 1000 : 1;
        sharesUnit = /^Principal Amount.*\(000s\)/.test(e.cells[0]) ? 1000 : 1;
        fund.unit = Math.max(fund.unit, valueUnit);
        continue;
      }
      const na =
        e.cells.length === 2 && /^NET ASSETS - 100(?:\.0)?%$/.test(e.cells[0]) ? parseAmount(e.cells[1]) : null;
      if (na !== null) {
        fund.netAssets = na * valueUnit;
        break;
      }
      if (e.cells.length === 1) {
        // a sector or industry heading ends in its weight ("Entertainment - 3.3%"); an issuer line does not
        issuer = /-\s*\(?[\d.]+\)?%$/.test(e.cells[0]) ? null : e.cells[0];
        continue;
      }
      // "Rad Power Bikes, Inc.:" + "Series A(a)(b)(c)" = "Rad Power Bikes, Inc. Series A", as the cost table prints it
      const cells =
        issuer && CLASS_LINE.test(e.cells[0])
          ? [`${issuer.replace(/:$/, '')} ${e.cells[0]}`, ...e.cells.slice(1)]
          : e.cells;
      const r = scheduleRow(cells, valueUnit, { sharesUnit });
      if (r) fund.schedule.push(r);
    }
    if (fund.netAssets === null) throw new Error(`Fidelity N-CSR: ${fund.fundName}: no "NET ASSETS - 100%" row`);
    for (; j < section.length; j++) {
      const total = restrictedFootnote(section[j]);
      if (total) fund.restrictedTotal = total;
      if (/^Additional information on each restricted holding/.test(rowText(section[j]))) break;
    }
    if (j >= section.length) {
      // fail closed: a stated restricted total without a cost table this code can find is an error
      if (fund.restrictedTotal)
        throw new Error(`Fidelity N-CSR: ${fund.fundName}: restricted securities stated but no cost table found`);
      return fund; // a fund with no restricted holdings
    }
    let costUnit = 1;
    const costRow = e =>
      e && e.type === 'row' && e.cells.length === 3 && parseDateRange(e.cells[1]) && parseAmount(e.cells[2]) !== null;
    for (j++; j < section.length; j++) {
      const { type, cells } = section[j];
      if (type !== 'row') {
        // a page break inside the table: page text, then the table goes on (with or without its header)
        const next = section.slice(j + 1, j + 8).find(x => x.type === 'row');
        if (next && (costRow(next) || /^Security \| Acquisition Date/.test(next.cells.join(' | ')))) continue;
        break;
      }
      if (/^Security \| Acquisition Date \| Acquisition Cost/.test(cells.join(' | '))) {
        costUnit = /\(000s\)/.test(cells[2]) ? 1000 : 1;
        continue;
      }
      const dates = cells.length === 3 ? parseDateRange(cells[1]) : null;
      const cost = cells.length === 3 ? parseAmount(cells[2]) : null;
      if (!dates || cost === null) break;
      fund.restricted.push({
        rawName: cells[0],
        name: securityName(cells[0]),
        acquiredFirst: dates.first,
        acquiredLast: dates.last,
        cost: cost * costUnit,
        costUnit,
        value: null,
        belowUnit: false,
        pctNav: null,
      });
    }
    if (!fund.restricted.length) throw new Error(`Fidelity N-CSR: ${fund.fundName}: restricted table has no rows`);
    return fund;
  });
}

const CAPITAL_HEADING = /^(?:Summary )?[Ii]nvestment portfolio (\w+ \d{1,2}, \d{4})/;
const CAPITAL_HEADER_WORDS = /^(?:Percent|Acquisition|Cost|Value|of net|date(?:\(s\))?|\(000\)|assets)$/;
const CAPITAL_TABLE_HEADER =
  /^(?:Private placement securities \| )?Acquisition date(?:\(s\))? \| Cost \(000\) \| Value \(000\) \| Percent of net assets$/;

// A footnote number printed in a cell of its own (2021-2024): after "—" (amount below one
// thousand: "— | 6 | 55 | .00") or after the percent (".00 | 15"). Rows of a restricted table
// have five cells: name, dates, cost, value, percent.
function footnoteCellsJoined(cells) {
  const out = [];
  for (const c of cells.map(x => x.replace(/^\$\s*([—–])$/, '$1')))
    if (/^%(?:\s*\d{1,2})?$/.test(c) && out.length)
      out[out.length - 1] += ' %'; // ".00 | % 17"
    else out.push(c);
  for (let i = 2; i < out.length - 1 && out.length > 5; i++)
    if (/^[—–]$/.test(out[i]) && /^\d{1,2}$/.test(out[i + 1])) out.splice(i, 2, `${out[i]} ${out[i + 1]}`);
  if (out.length === 6 && /^\d{1,2}$/.test(out[5]) && parsePct(out[4]) !== null) out.pop();
  return out;
}

// Capital Group schedule rows printed over four cells (2023-2024): a footnote after "—"
// ("2,257,143 | — | 6"), a note's currency in its own cell ("USD | 2,000 | 2,000"), or a
// sector label in front of the name.
function capitalScheduleCells(cells) {
  if (cells.length !== 4) return cells;
  if (/^[—–]$/.test(cells[2]) && /^\d{1,2}$/.test(cells[3])) return [cells[0], cells[1], `${cells[2]} ${cells[3]}`];
  if (/^[A-Z]{3}$/.test(cells[1])) return [cells[0], `${cells[1]} ${cells[2]}`, cells[3]];
  // a sector label or its weight in a side column (2024-09-30): "Industrials | Relativity Space, ... | 2,143,751 | 48,599"
  const label = /^(?:\d+\.\d+%|[A-Z][a-z]+(?: (?:[a-z]+|&|[A-Z][a-z]+))*)$/;
  if (label.test(cells[0]) && parseAmount(cells[1]) === null && parseAmount(cells[2]) !== null && thousands(cells[3]))
    return cells.slice(1);
  return cells;
}

function parseCapitalGroup(html) {
  const events = htmlEvents(html).map(e => (e.type === 'row' ? { ...e, cells: joinCells([...e.cells]) } : e));
  const headings = events.map((e, i) => (CAPITAL_HEADING.test(rowText(e)) ? i : -1)).filter(i => i >= 0);
  if (!headings.length) throw new Error('Capital Group N-CSR: no "Investment portfolio <date>" heading');
  if (headings.length > 1)
    throw new Error('Capital Group N-CSR: more than one investment portfolio (multi-fund filings are not supported)');
  const start = headings[0];
  const summary = /^Summary /.test(rowText(events[start]));
  const fund = {
    fundName: null, // one fund per filing: the filing header names the series
    periodEnd: parseLongDate(rowText(events[start])),
    unit: 1000,
    netAssets: null,
    summary,
    schedule: [],
    restricted: [],
    restrictedTotal: null,
  };
  // numeric footnote marks ("preferred shares 1,4") in every layout before 2026
  const numericMarks = !events.some(e => e.type === 'text' && /^Restricted securities \([a-z]{1,2}\)/.test(e.text));
  let j = start + 1;
  for (; j < events.length; j++) {
    const e = events[j];
    if (e.type !== 'row') continue;
    if (e.cells.length === 2 && /^Net assets 100\.00%$/.test(e.cells[0])) {
      fund.netAssets = parseAmount(e.cells[1]) * 1000;
      break;
    }
    const r = scheduleRow(capitalScheduleCells(e.cells), 1000, { numericMarks });
    if (r) fund.schedule.push(r);
  }
  if (fund.netAssets === null) throw new Error('Capital Group N-CSR: no "Net assets 100.00%" row');
  // the table's heading: a paragraph or, in some reports (2023-02-28), a one-cell row
  // ("Restricted securities 5"; "Private placement securities 4" in 2022)
  const isHeading = e =>
    (e.type === 'text' || e.cells.length === 1) && /^(?:Restricted|Private placement) securities\b/.test(rowText(e));
  const first = events.findIndex(
    (e, i) =>
      i > j &&
      ((isHeading(e) && !/\(continued\)/.test(rowText(e))) ||
        (e.type === 'row' && /^Private placement securities \| Acquisition date/.test(e.cells.join(' | '))))
  );
  // a summary portfolio prints the private holdings it names after the net-assets line
  if (summary)
    for (let k = j + 1; k < (first < 0 ? events.length : first); k++) {
      const r =
        events[k].type === 'row' ? scheduleRow(capitalScheduleCells(events[k].cells), 1000, { numericMarks }) : null;
      if (r) fund.schedule.push(r);
    }
  if (first < 0) {
    // fail closed: a cost table this code cannot find is an error, never "no restricted holdings"
    if (events.some((e, i) => i > j && e.type === 'row' && CAPITAL_TABLE_HEADER.test(e.cells.join(' | '))))
      throw new Error('Capital Group N-CSR: a restricted-securities table without a heading this parser reads');
    return [fund]; // no restricted holdings
  }
  // "Restricted securities (c)" or "Restricted securities 5": the mark of restricted rows in the portfolio
  const mark = isHeading(events[first])
    ? (rowText(events[first]).match(/^(?:Restricted|Private placement) securities \(?([a-z]{1,2}|\d{1,2})\)?/) ||
        [])[1] || null
    : null;
  let wrapped = null; // a name over two rows: "Candid Therapeutics, Inc., Class B," / "noncumulative ... shares 4 | ..."
  for (let k = isHeading(events[first]) ? first + 1 : first; k < events.length; k++) {
    const raw = events[k];
    if (isHeading(raw) && /\(continued\)/.test(rowText(raw))) continue;
    if (raw.type === 'text') break;
    if (raw.cells.length === 1 && /,$/.test(raw.cells[0])) {
      wrapped = raw.cells[0];
      continue;
    }
    const e = wrapped ? { ...raw, cells: [`${wrapped} ${raw.cells[0]}`, ...raw.cells.slice(1)] } : raw;
    wrapped = null;
    const line = e.cells.join(' | ');
    if (CAPITAL_TABLE_HEADER.test(line)) continue;
    // the header printed over three rows (2022): "Percent" / "Acquisition | Cost | Value | of net" / "date | (000) | ..."
    if (e.cells.every(c => CAPITAL_HEADER_WORDS.test(c))) continue;
    if (/^Total(?: private placement securities)?$/.test(e.cells[0])) {
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
    const cells = footnoteCellsJoined(e.cells);
    const dates = cells.length === 5 ? parseDateRange(cells[1]) : null;
    const cost = dates ? thousands(cells[2]) : null;
    const value = dates ? thousands(cells[3]) : null;
    if (!dates || cost === null || value === null)
      throw new Error(`Capital Group N-CSR: unreadable restricted row: ${line.slice(0, 160)}`);
    fund.restricted.push({
      rawName: cells[0],
      name: securityName(cells[0], numericMarks),
      acquiredFirst: dates.first,
      acquiredLast: dates.last,
      cost: cost.amount * 1000,
      costUnit: 1000,
      value: value.amount * 1000,
      // "—" (amount less than one thousand): the true amount is 0 to 999 dollars
      belowUnit: cost.belowUnit || value.belowUnit,
      pctNav: parsePct(cells[4]),
    });
  }
  if (!fund.restrictedTotal) throw new Error('Capital Group N-CSR: restricted table has no "Total" row');
  return [fund];
}

// T. Rowe Price: the document read as one line of text. Numbers end in a zero-width
// non-joiner (U+200C), which also ends the text before the next security name.
// T. Rowe Price: the document read as one line of text. Numbers end in a zero-width
// non-joiner (U+200C), which also ends the text before the next security name. The cost
// can be blank ("Hadrian Automation, Rights, ... Cost $ (1)(2)(3)": rights received at no
// cost) and so can the value ("Think & Learn ... 7,289 ", written down to nothing).
const TROWE_ROW = new RegExp(
  '([^\\u200c]{0,300}?), Acquisition Date: ([0-9/ ,\\-–]+?), Cost \\$\\s?([\\d,]+|—)?\\s*(?:\\(([A-Z]{3})\\))?\\s*' +
    '((?:\\(\\d{1,2}\\)\\s*)+)([\\d,.]+|—)\\u200c\\s*([\\d,.]+|—)?\\u200c',
  'g'
);

function parseTRowePrice(html) {
  const text = htmlEvents(html).map(rowText).join(' ');
  const statements = [
    ...text.matchAll(/(\w+ \d{1,2}, \d{4})(?: \(?Unaudited\)?)? Statement of Assets and Liabilities/g),
  ];
  if (!statements.length) throw new Error('T. Rowe Price N-CSR: no "Statement of Assets and Liabilities <date>"');
  // the statement prints NET ASSETS twice (the total and "Net Assets Consist of"): one fund, one amount
  const nets = [...new Set([...text.matchAll(/NET ASSETS \$ ([\d,]+)\u200c/g)].map(m => m[1]))];
  if (nets.length !== 1)
    throw new Error(
      `T. Rowe Price N-CSR: ${nets.length} different "NET ASSETS" amounts (one fund per filing is supported)`
    );
  const total = text.match(
    /aggregate value of restricted securities \(excluding 144A holdings\) at period end amounts to \$([\d,]+) and represents ([\d.]+)%/
  );
  // "(3) Security cannot be offered for public resale ...": the mark of restricted rows
  const mark = (text.match(/\((\d{1,2})\) Security cannot be offered for public resale/) || [])[1] || null;
  const fund = {
    fundName: null, // one fund per filing: the filing header names the series
    periodEnd: parseLongDate(statements[0][1]),
    unit: 1000,
    netAssets: parseAmount(nets[0]) * 1000,
    schedule: [],
    restricted: [],
    restrictedTotal: total ? { mark, value: parseAmount(total[1]) * 1000, pctNav: Number(total[2]) } : null,
  };
  const amount = s => (s === undefined || s === '—' ? 0 : parseAmount(s));
  for (const m of text.matchAll(TROWE_ROW)) {
    // the name follows the last heading with a weight ("Capital Markets 0.6% iCapital") and any
    // page header ("T. ROWE PRICE ... Shares/Par $ Value (Cost and value in $000s) ‡")
    const name = m[1]
      .replace(/^.*\d+(?:\.\d+)?%\s+/, '')
      .replace(/^.*\(Cost and value in \$000s\)\s*/, '')
      .replace(/^[‡†*\s]+/, '')
      .trim();
    const dates = parseDateRange(m[2].replace(/,\s*$/, ''));
    const shares = amount(m[6]);
    const value = amount(m[7]);
    if (!dates || shares === null || value === null)
      throw new Error(`T. Rowe Price N-CSR: unreadable restricted line: ${m[0].slice(-200)}`);
    const marks = [...m[5].matchAll(/\((\d{1,2})\)/g)].map(x => x[1]);
    const row = {
      rawName: name,
      name: securityName(name),
      shares,
      value: value * 1000,
      belowUnit: m[7] === '—',
      marks,
    };
    fund.schedule.push(row);
    fund.restricted.push({
      rawName: name,
      name: row.name,
      acquiredFirst: dates.first,
      acquiredLast: dates.last,
      cost: amount(m[3]) * 1000,
      costUnit: 1000,
      currency: m[4] || null, // "(INR)": the security's currency; the cost is printed in dollars
      shares, // the cost line is the schedule line: no pairing by name
      inline: true,
      value: row.value,
      belowUnit: row.belowUnit,
      pctNav: null,
    });
  }
  if (fund.restricted.length && !fund.restrictedTotal)
    throw new Error('T. Rowe Price N-CSR: restricted lines but no stated restricted total');
  return [fund];
}

// Morgan Stanley: "<name> (a)(c)(d) (acquisition cost — $63,187; acquired 8/31/21)".
const MS_COST = /\s*\(acquisition cost — \$([\d,]+); acquired ([0-9/ ,\-–]+)\)\s*$/;

function parseMorganStanley(html) {
  // the annual report splits "$ | 217,044" like Capital Group's
  const events = htmlEvents(html).map(e => (e.type === 'row' ? { ...e, cells: joinCells([...e.cells]) } : e));
  const starts = [];
  events.forEach((e, i) => {
    if (e.type === 'text' && /^(?:Consolidated )?Portfolio of Investments$/.test(e.text) && events[i + 1])
      starts.push({ i, name: rowText(events[i + 1]) });
  });
  if (!starts.length) throw new Error('Morgan Stanley N-CSR: no "Portfolio of Investments" section');
  return starts.map((s, k) => {
    const section = events.slice(s.i + 2, k + 1 < starts.length ? starts[k + 1].i : events.length);
    const fund = {
      fundName: cleanFundName(s.name),
      periodEnd: null,
      unit: 1,
      netAssets: null,
      schedule: [],
      restricted: [],
      restrictedTotal: null,
    };
    let valueUnit = 1;
    let mark = null;
    for (const e of section) {
      if (e.type === 'text') {
        if (!fund.periodEnd && /^\w+ \d{1,2}, \d{4}/.test(e.text)) fund.periodEnd = parseLongDate(e.text);
        continue;
      }
      const line = e.cells.join(' | ');
      if (/^(?:Shares|Face Amount|No\. of)/.test(line) && /Value \(000\)/.test(line)) {
        valueUnit = 1000;
        fund.unit = 1000;
        continue;
      }
      const f = e.cells.length === 2 && e.cells[0].match(/^\(([a-z]{1,2})\)$/);
      if (f && /^Security cannot be offered for public resale/.test(e.cells[1])) mark = f[1];
      if (e.cells.length === 2 && /^Net Assets \(100(?:\.0)?%\)$/.test(e.cells[0]) && fund.netAssets === null)
        fund.netAssets = parseAmount(e.cells[1]) * valueUnit;
      if (e.cells.length !== 3) continue;
      const cost = e.cells[0].match(MS_COST);
      const name = cost ? e.cells[0].replace(MS_COST, '') : e.cells[0];
      const value =
        e.cells[2] === '—' ? { amount: 0, belowUnit: true } : { amount: parseAmount(e.cells[2]), belowUnit: false };
      const r = scheduleRow([name, e.cells[1], value.amount === null ? e.cells[2] : String(value.amount)], valueUnit);
      if (!r) continue;
      r.belowUnit = value.belowUnit;
      fund.schedule.push(r);
      if (!cost) continue;
      const dates = parseDateRange(cost[2]);
      if (!dates) throw new Error(`Morgan Stanley N-CSR: unreadable acquisition date: ${line.slice(0, 160)}`);
      fund.restricted.push({
        rawName: name,
        name: r.name,
        acquiredFirst: dates.first,
        acquiredLast: dates.last,
        cost: parseAmount(cost[1]) * valueUnit,
        costUnit: valueUnit,
        shares: r.shares, // the cost line is the schedule line: no pairing by name
        inline: true,
        value: r.value,
        belowUnit: r.belowUnit,
        pctNav: null,
      });
    }
    if (fund.netAssets === null) throw new Error(`Morgan Stanley N-CSR: ${fund.fundName}: no "Net Assets (100%)" row`);
    // no stated restricted total: the checks are the restricted mark and each row's own numbers
    if (fund.restricted.length) fund.restrictedTotal = { mark, value: null, pctNav: null };
    return fund;
  });
}

const PARSERS = {
  fidelity: parseFidelity,
  capital: parseCapitalGroup,
  troweprice: parseTRowePrice,
  morganstanley: parseMorganStanley,
};

function parseNcsr(html, family) {
  const parse = PARSERS[family];
  if (!parse) throw new Error(`unknown N-CSR family: ${family}`);
  return parse(html);
}

module.exports = {
  parseNcsr,
  parseFidelity,
  parseCapitalGroup,
  parseTRowePrice,
  parseMorganStanley,
  TROWE_ROW,
  scheduleRow,
  restrictedFootnote,
  securityName,
  parsePct,
  thousands,
  joinCells,
  FAMILIES: Object.keys(PARSERS),
};
