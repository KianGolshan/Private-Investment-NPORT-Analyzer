// N-CSR documents are HTML only: their iXBRL tags cover Item 1 (the shareholder
// report) and no holding, cost or Level 3 fact (docs/plans/ncsr-research.md).
// This turns a document into one ordered stream of events, so a family parser
// can walk headings, paragraphs and table rows in the order the filer wrote them:
//   { type: 'text', text }   a paragraph outside a table
//   { type: 'row', cells }   one table row, its non-empty cell texts
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Visible text of an HTML fragment on one line: tags dropped, entities decoded,
// whitespace (non-breaking spaces too) collapsed.
function cellText(fragment) {
  return decode(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/[\s\u00a0\u200b]+/g, ' ')
    .trim();
}

function paragraphs(fragment, out) {
  const blocks = fragment.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '').split(/<\/?(?:p|div|br|h[1-6]|li)\b[^>]*>/i);
  for (const b of blocks) {
    const text = cellText(b);
    if (text) out.push({ type: 'text', text });
  }
}

function htmlEvents(html) {
  const out = [];
  const src = String(html);
  const tableRe = /<table\b[\s\S]*?<\/table>/gi;
  let last = 0;
  for (const t of src.matchAll(tableRe)) {
    paragraphs(src.slice(last, t.index), out);
    last = t.index + t[0].length;
    for (const tr of t[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
      const cells = [];
      for (const td of tr[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        const text = cellText(td[1]);
        if (text) cells.push(text);
      }
      if (cells.length) out.push({ type: 'row', cells });
    }
  }
  paragraphs(src.slice(last), out);
  return out;
}

// A whole-number amount as printed: "1,315,269", "$1,315,269", "(380,306)", "$(380,306". Returns null for
// anything else (dates, percentages, words), so a caller never reads a label as a number.
function parseAmount(s) {
  const t = String(s).replace(/\s/g, '');
  const m = t.match(/^\$?(\()?\$?(\d{1,3}(?:,\d{3})*|\d+)(\.\d+)?\)?$/);
  if (!m) return null;
  const v = Number((m[2] + (m[3] || '')).replace(/,/g, ''));
  return m[1] ? -v : v;
}

// "9/17/2014 - 6/5/2015", "1/27/2026-2/12/2026" or "5/31/2024" → ISO first and last dates; null otherwise.
function parseDateRange(s) {
  const m = String(s)
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4}))?$/);
  if (!m) return null;
  const iso = (mo, d, y) => `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const first = iso(m[1], m[2], m[3]);
  return { first, last: m[4] ? iso(m[4], m[5], m[6]) : first };
}

const MONTHS = 'January February March April May June July August September October November December'.split(' ');

// "May 31, 2026" → "2026-05-31"; null otherwise.
function parseLongDate(s) {
  const m = String(s).match(/\b([A-Z][a-z]+) (\d{1,2}), (\d{4})\b/);
  const mo = m ? MONTHS.indexOf(m[1]) : -1;
  if (mo < 0) return null;
  return `${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

// Footnote marks a filer appends to a security name: "(a)(b)", "(e)(f)", "(c) (d)".
const stripFootnotes = s =>
  String(s)
    .replace(/(\s*\([a-z]{1,2}\))+\s*$/, '')
    .trim();

module.exports = { htmlEvents, cellText, parseAmount, parseDateRange, parseLongDate, stripFootnotes };
