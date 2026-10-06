// Share-class labels as the class views group them (marks, holders, firm
// book). Kept apart from marks.js so firm.js can use them without a cycle.

// One spelling per class: filers write "F1" and "F-1", "Series D" and "D".
const classOf = label =>
  String(label || 'Unlabeled')
    .replace(/\b([A-Z]{1,3})-?(\d+)\b/g, '$1-$2')
    .replace(/\s+/g, ' ')
    .trim();

// One class across filers' categories (DATA-QUALITY trap 50). A series round
// is one security whatever category a filer files it under: BlackRock files
// Anthropic "SERIES G" as EC (labeled "Common G") where Fidelity files "SERIES
// G PC PP" as EP ("Preferred G"), both at $589.01; Capital Group's "CL G-1 PFD"
// and NY Life's "Series G-1" (EC) likewise. So a coded class is "Series X"
// unless the filer's own words make it common: an explicit COMMON, or a CLASS
// code with no series or preferred wording on an EC row (Stripe "CL B" stays
// "Common B", never Series B preferred). instrumentKey is unchanged (trap 47).
const PREFERRED_WORDS = /\bPFD\b|\bPREF\b|\bPREFERRED\b|\bCVT\b|\bCVY\b/;
// A class code the filer put in the issuer field when the title has none: T.
// Rowe Price files Canva as title "CANVA COMMON STOCK PP" with issuer "CANVA
// CLASS B COMMON STOCK PP" (0001099263-26-009584), the same Class B others name.
const CODE = /\b(?:SER(?:IES)?|CL(?:ASS)?)\b[.\s]+([A-Z0-9]{1,3}(?:-[A-Z0-9]{1,2})?)\b/;
function fromIssuer(label, issuerName) {
  const u = String(issuerName || '').toUpperCase();
  const m = (label === 'Common' || label === 'Preferred') && u.match(CODE);
  return m ? { label: `${label} ${m[1]}`, title: u } : null;
}

function classOfRow({ instrumentLabel, title, issuerName }) {
  const viaIssuer = fromIssuer(classOf(instrumentLabel), issuerName);
  if (viaIssuer) {
    instrumentLabel = viaIssuer.label;
    title = viaIssuer.title;
  }
  const label = classOf(instrumentLabel);
  const m = label.match(/^(Preferred|Common|Class) ([A-Z0-9]{1,3}(?:-[A-Z0-9]{1,2})?)( \(segregated\))?$/);
  if (!m) return label;
  const [, kind, code, seg = ''] = m;
  const t = String(title || '').toUpperCase();
  const pref = PREFERRED_WORDS.test(t);
  const saysCommon = !pref && /\bCOM(?:MON)?\b/.test(t);
  const classOnly = !pref && /\b(?:CL|CLASS)\b/.test(t) && !/\bSER(?:IES)?\b/.test(t);
  if (kind === 'Common' && (saysCommon || classOnly)) return `Common ${code}${seg}`;
  if (kind === 'Class') return `Class ${code}${seg}`;
  return `Series ${code}${seg}`;
}

// One class's marks at one mark date, one observation per fund (staff review
// F06): a fund with several lots of the class (several rows, or rows a generic
// label such as "Preferred" groups) counts once, at its lots' value over their
// shares. lots: [{ fundKey, value, shares }] with value and shares > 0. Medians
// and spreads are across funds; `severalMarks` counts funds whose own lots
// carry different marks (more than 0.1% apart), which the per-row list shows.
function fundMarks(lots) {
  const by = new Map();
  for (const l of lots) {
    const f =
      by.get(l.fundKey) || by.set(l.fundKey, { fundKey: l.fundKey, value: 0, shares: 0, prices: [] }).get(l.fundKey);
    f.value += l.value;
    f.shares += l.shares;
    f.prices.push(l.value / l.shares);
  }
  return [...by.values()].map(f => ({
    fundKey: f.fundKey,
    price: f.value / f.shares,
    lots: f.prices.length,
    severalMarks: Math.max(...f.prices) > Math.min(...f.prices) * 1.001,
  }));
}

const medianOf = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

// Median, low, high and fund count of a class at one mark date (fundMarks).
function markStats(lots) {
  const funds = fundMarks(lots);
  const prices = funds.map(f => f.price);
  return {
    funds: funds.length,
    median: medianOf(prices),
    low: Math.min(...prices),
    high: Math.max(...prices),
    severalMarks: funds.filter(f => f.severalMarks).length,
  };
}

module.exports = { classOf, classOfRow, fundMarks, markStats, medianOf };
