// Evidence-based company identity (ROADMAP §Phase 4.5, DATA-QUALITY traps
// 27 and 31-33). Nodes are issuer keys (parsers.issuerKeyOf, the seed
// clusters) with their raw names. An edge joins two nodes only on filing
// evidence and carries its kind, the accession that shows it and a
// confidence. Edge kinds, strongest first:
//
//   lei          the same issuer LEI (ISO 17442, check digits valid), trusted
//                when >= 2 filer families give it; a single filer's LEI on an
//                unrelated name needs the same mark on the same date;
//   instrument_id  one filer family (adviser firm, else registrant) reporting
//                the same instrument id under both names: a corroborated rename
//                in one fund, or two funds at the same mark on the same date.
//                Generic ids ("SEDOL", "Internal identifier", "999999999"),
//                ids a family uses for more than 3 names (escrows, CVRs) and
//                umbrella names (a trust over its series' ids) never count;
//   share_count  one fund's name A disappears and name B appears in its next
//                filing with the same share count (>= 10,000, not a round
//                lot), unique in both filings, value within 4x (Oura
//                1,123,976 sh; Anduril 306,011 sh);
//   same_mark    one filing gives both names the same per-share mark, at >= 2
//                different marks (Project Debussy = Databricks at $178.72 and
//                $179.40). Round prices and prices under $1 don't count;
//   title        the rows' own titles name the other company (>= 80% of the
//                rows: DOUYIN rows titled "BYTEDANCE LTD …"), or "dba" /
//                "formerly" wording ("FHU US HLDGS Units dba Chobani LLC");
//   name         the same name once spacing and abbreviations are normalized
//                ("FHU US HLDGS" = "FHU US" = "FHUS"; "OPEN AI" = "OPENAI",
//                never "OPENAIR"), or a per-fund holding vehicle named for it.
//
// Per-fund holding vehicles: a fund family that holds one target through a
// separate LLC per fund writes "<fund code> <target> HOLDINGS LLC" (Fidelity:
// "CONTSA FHUS HOLDINGS LLC", "BCGF VETERINARY HOLDINGS LLC"). A fund code is
// a leading token used by at most 2 funds for at least 2 different targets,
// each also held under another code. Such a vehicle links to a company only
// when its target spells the company's name; opaque targets stay vehicles
// (grouped by target) for the review list. Vehicles resolve as indirect.
//
// Companies are the connected components. Guardrails: a union that would join
// two different LEIs, a listed and a private company, two curated companies,
// or a pair curation.json keeps separate is recorded as a conflict and not
// made.
const { issuerKeyOf, ISSUER_SUFFIX_TOKENS } = require('../../parsers');
const { real, rawName, keyOf, FUND_LIKE, GENERIC_KEY } = require('./names');

const EDGE_ORDER = ['lei', 'instrument_id', 'share_count', 'same_mark', 'title', 'name'];
const CONFIDENCE = {
  lei: 'high',
  instrument_id: 'high',
  share_count: 'medium',
  same_mark: 'medium',
  title: 'medium',
  name: 'low',
};
const GENERIC_ID =
  /^(SEDOL|INTERNAL.*|SYSTEM GENERATED|OTHER|OTHERS|N\/?A|NONE|NULL|UNKNOWN|DUMMY.*|TBD|PRIVATE|0+|9+|X+|-+)$/i;
const MAX_NAMES_PER_ID = 3;
const MIN_SHARES = 10000;
const MAX_VALUE_JUMP = 4; // a rename keeps the position's value within 4x between filings
const MIN_MARK_PRICES = 2; // same-mark pairs must match at >= 2 different marks
const MAX_UMBRELLA_IDS = 3; // a name reported under >= 3 ids in one filing is a trust/umbrella name
const TITLE_SHARE = 0.8;
const MAX_CODE_FUNDS = 2;
const VEHICLE_TARGET =
  /^(.+?)\s+(HOLDINGS?|HLDGS?|HOLDCO|HLDCO)(,?\s+(LLC|L\.?\s?P\.?|INC\.?|LTD\.?))?\.?$|^(.+?)\s+(LLC|L\.?\s?P\.?)\.?$/;
const DBA = /\b(?:D\/?B\/?A|DOING BUSINESS AS|F\/?K\/?A|FORMERLY(?: KNOWN AS)?)\b[\s:.]+([A-Z0-9][A-Z0-9 .&'’-]*)/i;
const ABBREV = [
  [/\bHLDGS?\b/g, 'HOLDINGS'],
  [/\bHLDCO\b/g, 'HOLDCO'],
  [/\bTECH\b/g, 'TECHNOLOGIES'],
  [/\bINTL\b/g, 'INTERNATIONAL'],
  [/\bUNITS?\b/g, ' '],
];

// ISO 17442: 18 alphanumerics + 2 check digits, mod 97 = 1.
function validLei(s) {
  const lei = String(s || '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9]{18}[0-9]{2}$/.test(lei)) return '';
  let rem = 0;
  for (const ch of lei) {
    const d = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const x of d) rem = (rem * 10 + Number(x)) % 97;
  }
  return rem === 1 ? lei : '';
}

// Spelling variants of a key: abbreviations expanded, legal suffixes dropped,
// spaces removed; a letter doubled at a word join may be written once
// ("FHU US" -> "FHUUS" and "FHUS"). Keys shorter than 4 characters when
// compacted have no variants (too ambiguous).
function nameVariants(key) {
  // "HOCKEY PARENT DBA HUB INTL" is spelled by its issuer part (the brand is
  // an alias, trap 33).
  let k = ` ${key.replace(/\b(DBA|D B A|FKA|F K A|FORMERLY)\b.*$/, ' ')} `;
  for (const [re, to] of ABBREV) k = k.replace(re, to);
  const t = issuerKeyOf({ issuer: k.trim() }).split(' ').filter(Boolean);
  const compact = t.join('');
  if (compact.length < 4) return [];
  const out = new Set([compact]);
  if (t.length >= 2 && t[0].length >= 3) {
    let joined = t[0];
    for (const w of t.slice(1)) joined += joined.at(-1) === w[0] ? w.slice(1) : w;
    out.add(joined);
  }
  return [...out];
}

// Rows with what the edges need (and the seed's clusters): canonical filings,
// equity-type, value > 0, plus the identifiers, in a fixed order so the graph
// and its guarded components are the same on every run.
function identityRows(db) {
  return db
    .prepare(
      `SELECT h.accession, h.issuer_name, h.title, h.value_usd, h.fv_level, h.instrument_type, h.lei, h.other_id,
         h.balance, h.unit, h.company_id, h.via_spv, c.fund_key, c.report_date, c.cik
       FROM holdings h JOIN canonical_filings c ON c.accession = h.accession
       WHERE h.value_usd > 0 AND h.instrument_type <> 'debt'
       ORDER BY h.accession, h.row_key` // a fixed order: guarded unions depend on edge order
    )
    .all();
}

// fund_key -> filer family: its adviser's firm (managers), else its registrant.
function fundFamilies(db) {
  const out = new Map();
  for (const r of db
    .prepare(
      `SELECT fa.fund_key, MIN(ma.manager_id) m FROM fund_advisers fa
       JOIN manager_advisers ma ON ma.file_num = fa.file_num WHERE fa.role = 'adviser' GROUP BY fa.fund_key`
    )
    .all())
    out.set(r.fund_key, `M${r.m}`);
  return out;
}

class Edges {
  constructor() {
    this.list = [];
    this.seen = new Set();
  }
  add(a, b, kind, accession, detail) {
    if (!a || !b || a === b || GENERIC_KEY.test(a) || GENERIC_KEY.test(b)) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    const k = `${x}\u0000${y}\u0000${kind}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.list.push({ a: x, b: y, kind, accession: accession || '', confidence: CONFIDENCE[kind], detail });
  }
}

function buildNodes(rows) {
  const nodes = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    if (!key) continue;
    r.key = key;
    let n = nodes.get(key);
    if (!n)
      nodes.set(key, (n = { key, raw: new Map(), rows: 0, funds: new Set(), leis: new Map(), brands: new Map() }));
    n.rows++;
    const raw = rawName(r);
    let e = n.raw.get(raw);
    if (!e) n.raw.set(raw, (e = { rows: 0, funds: new Set() }));
    e.rows++;
    e.funds.add(r.fund_key);
    n.funds.add(r.fund_key);
  }
  return nodes;
}

const familyOf = (r, families) => families.get(r.fund_key) || `CIK${r.cik}`;

// Fund interests (hedge and PE fund stakes) reuse id slots and share counts
// between unrelated funds; two fund-like names with different first words are
// never linked by identifiers.
const firstWord = k => k.split(' ')[0];
const fundPair = (a, b) => FUND_LIKE.test(a) && FUND_LIKE.test(b) && firstWord(a) !== firstWord(b);

// A mark (value / shares, to the cent) specific enough to identify a
// security: >= $1, not a round price, >= 4 significant digits. Reported
// values are rounded, so the price itself is rarely a whole number of cents
// ($2,406,216.46 / 3,499 = $687.6869 -> $687.69).
function markCents(r) {
  if (!(r.balance > 0) || r.unit !== 'NS') return null;
  const px = r.value_usd / r.balance;
  if (px < 1) return null;
  const cents = Math.round(px * 100);
  if (cents % 25 === 0) return null;
  if (String(cents).replace(/0+$/, '').length < 4) return null;
  return cents;
}

// key -> date -> Set(cents): every specific mark a key carries on a date, in
// any filing. Two names at the same specific mark on the same date corroborate
// a single filer's LEI or instrument id.
function marksByKey(rows) {
  const out = new Map();
  for (const r of rows) {
    const c = r.key && markCents(r);
    if (!c) continue;
    if (!out.has(r.key)) out.set(r.key, new Map());
    const m = out.get(r.key);
    if (!m.has(r.report_date)) m.set(r.report_date, new Set());
    m.get(r.report_date).add(c);
  }
  return out;
}
function sharedMark(marks, a, b) {
  const A = marks.get(a);
  const B = marks.get(b);
  if (!A || !B) return null;
  for (const [date, cs] of A) {
    const other = B.get(date);
    if (other) for (const c of cs) if (other.has(c)) return { date, cents: c };
  }
  return null;
}
// Visibly the same name: a shared spelling variant, one name a whole-word
// prefix of the other ("IQHQ" / "IQHQ DIRECT REAL ESTATE"), or a typo (edit
// distance <= 2 on 8+ letters: "CINEWROLD", "HOOSPITALITY"). A shared first
// word alone is not ("EVEREST RE" / "EVEREST MEDICINES", "RELIANCE STEEL" /
// "RELIANCE INDUSTRIES").
function relatedNames(a, b) {
  const va = new Set(nameVariants(a));
  if (nameVariants(b).some(v => va.has(v))) return true;
  if (a.startsWith(`${b} `) || b.startsWith(`${a} `)) return true;
  const [x, y] = [a, b].map(k => k.replace(/[^A-Z0-9]/g, ''));
  return x.length >= 8 && y.length >= 8 && x[0] === y[0] && editDistance(x, y, 2) <= 2;
}
function editDistance(x, y, max) {
  if (Math.abs(x.length - y.length) > max) return max + 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}
const markText = m => `same mark $${(m.cents / 100).toFixed(2)} on ${m.date}`;

// An LEI's home is the name most filer families give it; it counts when >= 2
// families give it there (one family's LEI on several names is often its own
// or a placeholder: a fund of hedge funds put one LEI on Magnetar, Millennium
// and Element). Another name joins the home when >= 2 families give it the
// LEI, or its names are related, or it carries the home's mark on the same
// date. A single filer's LEI on an unrelated name is otherwise as likely a
// wrong LEI (Everest Re's on Everest Medicines) as a wrong name (Anthropic's
// on BlackRock's "Anthropics Technology Ltd., Series G", priced at Anthropic's
// marks). leiOfKey holds trusted LEIs at their home only.
function leiEdges(rows, families, edges, marks) {
  const byLei = new Map();
  for (const r of rows) {
    const lei = validLei(r.lei);
    if (!lei || !r.key) continue;
    let m = byLei.get(lei);
    if (!m) byLei.set(lei, (m = new Map()));
    const e = m.get(r.key) || { rows: 0, families: new Set(), accession: r.accession };
    e.rows++;
    e.families.add(familyOf(r, families));
    m.set(r.key, e);
  }
  const leiOfKey = new Map();
  for (const [lei, m] of byLei) {
    const ranked = [...m].sort((a, b) => b[1].families.size - a[1].families.size || b[1].rows - a[1].rows);
    const [home, h] = ranked[0];
    if (h.families.size < 2) continue;
    if (!leiOfKey.has(home)) leiOfKey.set(home, new Set());
    leiOfKey.get(home).add(lei);
    for (const [k, e] of ranked.slice(1)) {
      const mark = e.families.size < 2 && !relatedNames(home, k) ? sharedMark(marks, home, k) : null;
      if (e.families.size < 2 && !relatedNames(home, k) && !mark) continue;
      edges.add(home, k, 'lei', e.accession, mark ? `${lei}; ${markText(mark)}` : lei);
    }
  }
  return { leiOfKey };
}

// A share count specific enough to follow a position: >= 10,000 shares and
// not a round lot.
const specificShares = n => n >= MIN_SHARES && n % 100 !== 0;

// The same instrument id under two names in one filer family:
//   - a rename: one fund reports it as A, then as B (A never again, never
//     both in one filing), corroborated by a structured id, the same share
//     count, the same rename in >= 2 funds, related names, or the same mark on
//     the same date;
//   - one security: two of the family's funds report it on the same date at
//     the same specific mark (BlackRock's "ANTHROPIC SERIES G" and
//     "Anthropics Technology Ltd., Series G", both BYDXGRZL8 at $259.14 on
//     2026-03-31).
// Umbrella names (a trust reported under several series' ids) never count.
function instrumentIdEdges(rows, families, edges, marks, local) {
  const byId = new Map();
  const idsOfKey = new Map(); // family + key -> ids
  const idsInFiling = new Map(); // accession + key -> ids
  for (const r of rows) {
    const id = String(r.other_id || '')
      .trim()
      .toUpperCase();
    if (!r.key || id.length < 5 || GENERIC_ID.test(id)) continue;
    const fam = familyOf(r, families);
    const k = `${fam}\u0000${id}`;
    let list = byId.get(k);
    if (!list) byId.set(k, (list = []));
    list.push(r);
    for (const [map, mk] of [
      [idsOfKey, `${fam}\u0000${r.key}`],
      [idsInFiling, `${r.accession}\u0000${r.key}`],
    ]) {
      if (!map.has(mk)) map.set(mk, new Set());
      map.get(mk).add(id);
    }
  }
  // A company reports one id per share class; an umbrella's ids are each also
  // reported under another name (the series' own names).
  const namesOfId = new Map(); // family + id -> keys
  for (const [k, list] of byId) namesOfId.set(k, new Set(list.map(r => r.key)));
  const sharedIds = (fam, key, ids) =>
    [...ids].filter(id => [...(namesOfId.get(`${fam}\u0000${id}`) || [])].some(k => k !== key)).length;
  const famOfAccession = new Map(rows.map(r => [r.accession, familyOf(r, families)]));
  const umbrella = new Set();
  for (const [k, ids] of idsInFiling) {
    const [acc, key] = k.split('\u0000');
    if (ids.size >= MAX_UMBRELLA_IDS && sharedIds(famOfAccession.get(acc), key, ids) >= MAX_UMBRELLA_IDS)
      umbrella.add(key);
  }
  for (const [k, ids] of idsOfKey) {
    const [fam, key] = k.split('\u0000');
    if (ids.size >= MAX_UMBRELLA_IDS && sharedIds(fam, key, ids) >= MAX_UMBRELLA_IDS) umbrella.add(key);
  }

  const renames = new Map(); // "A\0B" -> { funds, sameShares, accession, ids }
  for (const [k, list] of byId) {
    const keys = new Set(list.map(r => r.key));
    if (keys.size < 2 || keys.size > MAX_NAMES_PER_ID) continue;
    const id = k.split('\u0000')[1];
    const byFund = new Map();
    for (const r of list) {
      if (!byFund.has(r.fund_key)) byFund.set(r.fund_key, []);
      byFund.get(r.fund_key).push(r);
    }
    for (const fr of byFund.values()) {
      fr.sort((a, b) => a.report_date.localeCompare(b.report_date));
      for (let i = 1; i < fr.length; i++) {
        const [a, b] = [fr[i - 1], fr[i]];
        if (a.key === b.key || a.report_date === b.report_date || fundPair(a.key, b.key)) continue;
        if (umbrella.has(a.key) || umbrella.has(b.key)) continue;
        if (fr.slice(i).some(x => x.key === a.key)) continue;
        const datesA = new Set(fr.filter(x => x.key === a.key).map(x => x.report_date));
        if (fr.some(x => x.key === b.key && datesA.has(x.report_date))) continue;
        const rk = `${a.key}\u0000${b.key}`;
        const e = renames.get(rk) || { funds: new Set(), sameShares: false, accession: b.accession, id, family: k };
        e.funds.add(a.fund_key);
        // Filers reuse their own ids (even CUSIP-shaped ones: BlackRock's
        // BRTGP5LH5 went from DiDi to Ant), so a rename needs corroboration.
        if (specificShares(a.balance) && a.balance === b.balance) e.sameShares = true;
        renames.set(rk, e);
      }
    }
    const byDate = new Map();
    for (const r of list) {
      const c = markCents(r);
      if (!c) continue;
      const d = `${r.report_date}\u0000${c}`;
      if (!byDate.has(d)) byDate.set(d, new Map());
      if (!byDate.get(d).has(r.key)) byDate.get(d).set(r.key, r);
    }
    for (const [d, m] of byDate) {
      if (m.size < 2) continue;
      const [first, ...rest] = [...m.values()];
      for (const r of rest) {
        if (fundPair(first.key, r.key) || umbrella.has(first.key) || umbrella.has(r.key)) continue;
        const [date, cents] = d.split('\u0000');
        edges.add(first.key, r.key, 'instrument_id', r.accession, `${id}: ${markText({ date, cents })}`);
      }
    }
  }
  for (const [rk, e] of renames) {
    const [a, b] = rk.split('\u0000');
    // One fund's rename between unrelated names links the names only if both
    // are this family's own: a key other filers use would carry their rows
    // along (BlackRock's one 2019 row labeled "Xiaoju Kuaizhi" is its Ant
    // position; every other filer's XIAOJU KUAIZHI is DiDi).
    const fam = e.family.split('\u0000')[0];
    if (e.funds.size < 2 && !relatedNames(a, b) && !(local(a, fam) && local(b, fam))) continue;
    const mark = sharedMark(marks, a, b);
    const why = e.sameShares
      ? 'same share count'
      : e.funds.size >= 2
        ? `${e.funds.size} funds`
        : relatedNames(a, b)
          ? 'related names'
          : mark
            ? markText(mark)
            : '';
    if (why) edges.add(a, b, 'instrument_id', e.accession, `${e.id}: renamed (${why})`);
  }
}

// Consecutive canonical filings of one fund: name A (gone) -> name B (new),
// the same share count, unique in both filings.
function shareCountEdges(rows, edges, families, local) {
  const byFund = new Map();
  for (const r of rows) {
    // Round lots (500,000 sh) recur by chance; renames keep odd counts (1,123,976).
    if (!r.key || !specificShares(r.balance) || r.unit !== 'NS') continue;
    let f = byFund.get(r.fund_key);
    if (!f) byFund.set(r.fund_key, (f = new Map()));
    let filing = f.get(r.report_date);
    if (!filing)
      f.set(
        r.report_date,
        (filing = {
          accession: r.accession,
          family: familyOf(r, families),
          keys: new Set(),
          byBalance: new Map(),
          value: new Map(),
        })
      );
    filing.keys.add(r.key);
    filing.value.set(r.key, (filing.value.get(r.key) || 0) + r.value_usd);
    const b = filing.byBalance.get(r.balance) || new Set();
    b.add(r.key);
    filing.byBalance.set(r.balance, b);
  }
  for (const f of byFund.values()) {
    const dates = [...f.keys()].sort();
    for (let i = 1; i < dates.length; i++) {
      const prev = f.get(dates[i - 1]);
      const cur = f.get(dates[i]);
      for (const [bal, keys] of cur.byBalance) {
        const before = prev.byBalance.get(bal);
        if (!before || keys.size !== 1 || before.size !== 1) continue;
        const [b] = keys;
        const [a] = before;
        if (a === b || cur.keys.has(a) || prev.keys.has(b) || fundPair(a, b)) continue;
        const ratio = cur.value.get(b) / prev.value.get(a);
        if (!(ratio <= MAX_VALUE_JUMP && ratio >= 1 / MAX_VALUE_JUMP)) continue;
        if (!relatedNames(a, b) && !(local(a, cur.family) && local(b, cur.family))) continue;
        edges.add(a, b, 'share_count', cur.accession, `${bal} sh`);
      }
    }
  }
}

function sameMarkEdges(rows, edges) {
  const byAcc = new Map();
  for (const r of rows) {
    const cents = r.key && markCents(r);
    if (!cents) continue;
    let m = byAcc.get(r.accession);
    if (!m) byAcc.set(r.accession, (m = new Map()));
    const s = m.get(cents) || new Set();
    s.add(r.key);
    m.set(cents, s);
  }
  const pairs = new Map();
  for (const [acc, m] of byAcc) {
    for (const [cents, keys] of m) {
      if (keys.size !== 2) continue;
      const [a, b] = [...keys].sort();
      const k = `${a}\u0000${b}`;
      const p = pairs.get(k) || { filings: 0, accession: acc, cents, prices: new Set() };
      p.filings++;
      p.prices.add(cents);
      pairs.set(k, p);
    }
  }
  for (const [k, p] of pairs) {
    if (p.prices.size < MIN_MARK_PRICES) continue;
    const [a, b] = k.split('\u0000');
    if (fundPair(a, b)) continue;
    edges.add(
      a,
      b,
      'same_mark',
      p.accession,
      `same marks at ${p.prices.size} prices in ${p.filings} filings, e.g. $${(p.cents / 100).toFixed(2)}/sh`
    );
  }
}

function titleEdges(rows, nodes, edges) {
  const titled = new Map();
  for (const r of rows) {
    if (!r.key) continue;
    const text = `${real(r.issuer_name)} ${real(r.title)}`;
    const dba = DBA.exec(text);
    if (dba) {
      const brand = dba[1]
        .replace(/\b(LLC|INC|PP|UNITS?)\b.*$/i, '')
        .trim()
        .replace(/\s+[A-Z]$/i, ''); // a trailing class letter ("HUB INTL A")
      const n = nodes.get(r.key);
      if (brand.length >= 3 && !n.brands.has(brand.toUpperCase()))
        n.brands.set(brand.toUpperCase(), { brand, accession: r.accession });
      const bk = issuerKeyOf({ issuer: brand });
      if (nodes.has(bk)) edges.add(r.key, bk, 'title', r.accession, `"${dba[0].trim()}"`);
    }
    if (!real(r.issuer_name) || !real(r.title)) continue;
    const tk = issuerKeyOf({ title: r.title });
    if (!tk || tk === r.key || GENERIC_KEY.test(tk)) continue;
    let t = titled.get(r.key);
    if (!t) titled.set(r.key, (t = new Map()));
    const e = t.get(tk) || { n: 0, accession: r.accession };
    e.n++;
    t.set(tk, e);
  }
  for (const [key, t] of titled) {
    const n = nodes.get(key);
    for (const [tk, e] of t) {
      if (e.n / n.rows >= TITLE_SHARE && nodes.has(tk)) edges.add(key, tk, 'title', e.accession, `titles read "${tk}"`);
    }
  }
}

const CORPORATE_LAYER =
  /^(PARENT|TOPCO|HOLDCO|MIDCO|BIDCO|INTERMEDIATE|BUYER|ACQUISITION|AGGREGATOR|INVESTOR|INVESTORS)$/;
// A vehicle target must name something: "EBSC HOLDINGS LLC" is a company,
// not fund code "EBSC" + target "HOLDINGS LLC".
function namesTarget(rest) {
  const m = VEHICLE_TARGET.exec(rest);
  if (!m) return false;
  const t = issuerKeyOf({ issuer: (m[1] || m[5]).trim() });
  // Nor is a co-invest or fund name ("ASTRO CO-INVEST, L.P.") a code + target,
  // or a corporate-layer word ("ICEBOX PARENT LP", "IEM PARENT, LP").
  return (
    t.replace(/[^A-Z0-9]/g, '').length >= 2 &&
    !ISSUER_SUFFIX_TOKENS.has(t) &&
    !FUND_LIKE.test(t) &&
    !CORPORATE_LAYER.test(t)
  );
}
// Fund codes and the per-fund vehicles that use them (see the header).
function perFundVehicles(nodes) {
  const byPrefix = new Map();
  for (const n of nodes.values()) {
    for (const [raw, e] of n.raw) {
      const m = /^([A-Z0-9]{2,9}) (.+)$/.exec(raw);
      if (!m || !VEHICLE_TARGET.test(m[2])) continue;
      let p = byPrefix.get(m[1]);
      if (!p) byPrefix.set(m[1], (p = { funds: new Set(), rests: new Map() }));
      for (const f of e.funds) p.funds.add(f);
      const list = p.rests.get(m[2]) || [];
      list.push({ node: n, raw, funds: e.funds });
      p.rests.set(m[2], list);
    }
  }
  const prefixesOf = new Map();
  for (const [p, x] of byPrefix)
    for (const rest of x.rests.keys()) {
      if (!prefixesOf.has(rest)) prefixesOf.set(rest, new Set());
      prefixesOf.get(rest).add(p);
    }
  const codes = new Set();
  for (const [p, x] of byPrefix) {
    if (x.funds.size > MAX_CODE_FUNDS) continue;
    const shared = [...x.rests.keys()].filter(r => prefixesOf.get(r).size >= 2 && namesTarget(r));
    if (new Set(shared.map(s => s.split(' ')[0])).size >= 2) codes.add(p);
  }
  // Targets held under >= 2 codes; then every single-fund "<token> <target>".
  const targets = new Set();
  for (const [rest, ps] of prefixesOf)
    if (namesTarget(rest) && [...ps].filter(p => codes.has(p)).length >= 2) targets.add(rest);
  const vehicles = new Map(); // node key -> { target, targetName, code, raws }
  for (const [p, x] of byPrefix) {
    if (x.funds.size > MAX_CODE_FUNDS) continue;
    for (const [rest, list] of x.rests) {
      if (!targets.has(rest)) continue;
      const m = VEHICLE_TARGET.exec(rest);
      const targetName = (m[1] || m[5]).trim();
      for (const { node, raw } of list) {
        const v = vehicles.get(node.key) || { target: rest, targetName, code: p, raws: new Set() };
        v.raws.add(raw);
        vehicles.set(node.key, v);
      }
    }
  }
  return { codes, targets, vehicles };
}

function nameEdges(nodes, vehicles, edges) {
  const byVariant = new Map();
  for (const n of nodes.values()) {
    if (vehicles.has(n.key)) continue;
    for (const v of nameVariants(n.key)) {
      if (!byVariant.has(v)) byVariant.set(v, new Set());
      byVariant.get(v).add(n.key);
    }
  }
  for (const keys of byVariant.values()) {
    const [first, ...rest] = [...keys].sort();
    for (const k of rest) edges.add(first, k, 'name', '', 'same name, spacing/abbreviation normalized');
  }
  // A per-fund vehicle links to the company its target spells. Vehicles with
  // the same opaque target link to each other (one vehicle entry to review).
  const byTarget = new Map();
  for (const [key, v] of vehicles) {
    const hits = new Set(nameVariants(v.targetName).flatMap(x => [...(byVariant.get(x) || [])]));
    // Several hits are spellings of one name ("FHU US", "FHU US HLDGS"): they
    // share a variant, so name edges join them; link to the first.
    v.company = hits.size ? [...hits].sort()[0] : null;
    if (v.company) edges.add(key, v.company, 'name', '', `per-fund vehicle "${v.code} ${v.target}" of "${v.company}"`);
    const list = byTarget.get(v.target) || [];
    list.push(key);
    byTarget.set(v.target, list);
  }
  for (const [target, keys] of byTarget) {
    for (const k of keys.slice(1)) edges.add(keys[0], k, 'name', '', `per-fund vehicles for "${target}"`);
  }
}

// Companies are the connected components. Union-find over the edges,
// strongest kind first, with guards. Context:
//   statusOf    key -> 'public' | 'private' | '' (listing evidence, curated status)
//   companiesOf key -> [ids] of the curated companies the key already belongs to
//   separate    [{ a, b, reason }] issuer-key pairs never to join (curation.json)
//   exclude     keys that join nothing (curation drops)
// A union that would join two different trusted LEIs, a listed and a private
// company, two curated companies, or a separated pair is not made: the edge is
// returned as a conflict. Marks each edge applied / not.
function linkComponents(
  graph,
  { statusOf = () => '', companiesOf = () => [], separate = [], exclude = new Set(), preset = [] } = {}
) {
  const { nodes, edges, leiOfKey } = graph;
  const parent = new Map();
  const info = new Map();
  for (const key of nodes.keys()) {
    parent.set(key, key);
    info.set(key, {
      leis: new Set(leiOfKey.get(key) || []),
      status: new Set([statusOf(key)].filter(Boolean)),
      companies: new Set(companiesOf(key)),
      keys: [key],
    });
  }
  const find = k => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(k) !== r) {
      const next = parent.get(k);
      parent.set(k, r);
      k = next;
    }
    return r;
  };
  const union = (ra, rb) => {
    const [big, small] = info.get(ra).keys.length >= info.get(rb).keys.length ? [ra, rb] : [rb, ra];
    parent.set(small, big);
    const I = info.get(big);
    const S = info.get(small);
    for (const f of ['leis', 'status', 'companies']) for (const v of S[f]) I[f].add(v);
    I.keys.push(...S.keys);
    info.delete(small);
  };
  // Keys already known to be one company (a curated group) start joined, so
  // the guards see the whole company, not one spelling of it.
  for (const keys of preset) {
    const inside = keys.filter(k => parent.has(k));
    for (const k of inside.slice(1)) {
      const [ra, rb] = [find(inside[0]), find(k)];
      if (ra !== rb) union(ra, rb);
    }
  }
  const apart = new Set(separate.flatMap(s => [`${s.a}\u0000${s.b}`, `${s.b}\u0000${s.a}`]));
  const conflicts = [];
  const order = [...edges].sort((x, y) => EDGE_ORDER.indexOf(x.kind) - EDGE_ORDER.indexOf(y.kind));
  for (const e of order) {
    e.applied = false;
    delete e.conflict;
    if (exclude.has(e.a) || exclude.has(e.b)) continue;
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra === rb) {
      e.applied = true;
      continue;
    }
    const A = info.get(ra);
    const B = info.get(rb);
    const reasons = [];
    if (A.leis.size && B.leis.size && ![...A.leis].some(l => B.leis.has(l))) reasons.push('two different LEIs');
    if ((A.status.has('public') && B.status.has('private')) || (A.status.has('private') && B.status.has('public')))
      reasons.push('a listed and a private company');
    if (A.companies.size && B.companies.size && ![...A.companies].some(c => B.companies.has(c)))
      reasons.push('two curated companies');
    if (A.keys.some(a => B.keys.some(b => apart.has(`${a}\u0000${b}`)))) reasons.push('kept separate by curation');
    if (reasons.length) {
      e.conflict = reasons.join('; ');
      conflicts.push(e);
      continue;
    }
    union(ra, rb);
    e.applied = true;
  }
  const componentOf = new Map([...nodes.keys()].map(k => [k, find(k)]));
  const components = new Map();
  for (const root of new Set(componentOf.values())) components.set(root, { root, ...info.get(root) });
  return { componentOf, components, conflicts };
}

// How each key of a component is reached from `from` over applied edges:
// key -> the edge that reached it (breadth first, so the shortest evidence path).
function evidencePaths(graph, keys, from) {
  const inside = new Set(keys);
  const adj = new Map();
  for (const e of graph.edges) {
    if (!e.applied || !inside.has(e.a) || !inside.has(e.b)) continue;
    for (const [x, y] of [
      [e.a, e.b],
      [e.b, e.a],
    ]) {
      if (!adj.has(x)) adj.set(x, []);
      adj.get(x).push([y, e]);
    }
  }
  const via = new Map();
  const queue = [...from].filter(k => inside.has(k));
  const seen = new Set(queue);
  while (queue.length) {
    const k = queue.shift();
    for (const [y, e] of adj.get(k) || []) {
      if (seen.has(y)) continue;
      seen.add(y);
      via.set(y, e);
      queue.push(y);
    }
  }
  return via;
}

// The evidence graph over the given rows (no components yet: linkComponents).
//   families   fund_key -> filer family (fundFamilies(db))
function buildIdentity(rows, { families = new Map() } = {}) {
  const nodes = buildNodes(rows);
  const edges = new Edges();
  const marks = marksByKey(rows);
  const { leiOfKey } = leiEdges(rows, families, edges, marks);
  // A key is local to a filer family when only that family reports it.
  const familiesOfKey = new Map();
  for (const r of rows) {
    if (!r.key) continue;
    if (!familiesOfKey.has(r.key)) familiesOfKey.set(r.key, new Set());
    familiesOfKey.get(r.key).add(familyOf(r, families));
  }
  const local = (key, fam) => {
    const f = familiesOfKey.get(key);
    return !!f && f.size === 1 && f.has(fam);
  };
  instrumentIdEdges(rows, families, edges, marks, local);
  shareCountEdges(rows, edges, families, local);
  sameMarkEdges(rows, edges);
  titleEdges(rows, nodes, edges);
  const { codes, vehicles } = perFundVehicles(nodes);
  nameEdges(nodes, vehicles, edges);
  return { nodes, edges: edges.list, vehicles, codes, leiOfKey };
}

module.exports = {
  buildIdentity,
  linkComponents,
  evidencePaths,
  identityRows,
  fundFamilies,
  nameVariants,
  validLei,
  EDGE_ORDER,
  CONFIDENCE,
};
