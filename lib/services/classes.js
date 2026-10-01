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

module.exports = { classOf, classOfRow };
