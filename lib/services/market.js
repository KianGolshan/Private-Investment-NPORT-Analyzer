// Market-wide views over the warehouse, all under the as-of rule (ADR 0004):
// at date D every fund contributes its latest canonical filing on or before D,
// if that filing is within 123 days of D. The same rule as exposureAsOf (a
// test holds them equal per company), computed for every fund at once.
//   topCompanies   private companies ranked by fund holdings as of D
//   countries      private-company exposure by the issuer country filed
//   feed           position changes in filings made since a date
const { fundChanges } = require('../analytics/activity');
const { INACTIVE_DAYS } = require('../analytics/asof');
const { memo } = require('./memo');
const { ServiceError, isIsoDate } = require('./errors');

// What a reviewed company is (migration 0022, review F-03): an operating
// company, or a fund interest, CLO or insurance vehicle that funds also report.
const CATEGORIES = ['company', 'fund', 'clo', 'insurance'];

// The ids of the companies in `categories` (a list), or null for every one.
function categoryIds(db, categories) {
  if (!categories || !categories.length) return null;
  for (const c of categories)
    if (!CATEGORIES.includes(c)) throw new ServiceError(400, `category must be one of ${CATEGORIES.join(', ')}`);
  return new Set(
    db
      .prepare(`SELECT id FROM companies WHERE category IN (${categories.map(() => '?').join(',')})`)
      .all(...categories)
      .map(r => r.id)
  );
}

// The rows that count toward exposure (lib/analytics/asof.js countsRule and
// EQUITY_BY.instrument_type, nullBalance true).
const COUNTS = `h.instrument_type IN ('equity','indirect','derivative') AND h.value_usd > 0
  AND (h.balance > 0 OR h.balance IS NULL OR h.balance = 0)`;

// Each active fund's filing as of @date (optionally only @funds, a JSON array).
// known: only filings made on or before @known count, amendments included
// ("what was public that day"; asof.js KNOWN_CANONICAL, the same rule as
// exposureAsOf's knownAsOf, held equal by a test). Without it every filing
// made so far counts, including reports filed after @date (review 2026-10-18
// #2: at 2026-06-30, $53.8B of $62.2B came from filings made later).
const activeFilings = (funds, known = false) => `
  latest AS (
    SELECT fund_key, MAX(report_date) d FROM filings
    WHERE report_date <= @date ${known ? 'AND filing_date <= @known' : ''}
      ${funds ? 'AND fund_key IN (SELECT value FROM json_each(@funds))' : ''}
    GROUP BY fund_key HAVING julianday(@date) - julianday(MAX(report_date)) <= ${INACTIVE_DAYS}),
  active AS (
    SELECT c.accession, c.fund_key, c.report_date FROM ${known ? 'filings' : 'canonical_filings'} c
    JOIN latest l ON l.fund_key = c.fund_key AND c.report_date = l.d
    ${
      known
        ? `WHERE c.filing_date <= @known AND NOT EXISTS (
      SELECT 1 FROM filings g
      WHERE g.fund_key = c.fund_key AND g.report_date = c.report_date AND g.accession <> c.accession
        AND g.filing_date <= @known
        AND (g.filing_date > c.filing_date
          OR (g.filing_date = c.filing_date AND (g.form = 'NPORT-P/A') > (c.form = 'NPORT-P/A'))
          OR (g.filing_date = c.filing_date AND (g.form = 'NPORT-P/A') = (c.form = 'NPORT-P/A')
              AND g.accession > c.accession)))`
        : ''
    })`;

// knownAsOf: true (= the as-of date), an ISO date, or nothing (every filing so far).
function knownOf(knownAsOf, date) {
  if (knownAsOf == null || knownAsOf === false || knownAsOf === '') return null;
  const k = knownAsOf === true ? date : knownAsOf;
  if (!isIsoDate(k)) throw new ServiceError(400, 'knownAsOf must be an ISO date (YYYY-MM-DD)');
  return k;
}

function newestReportDate(db) {
  return db.prepare('SELECT MAX(as_of) d FROM company_stats').get().d;
}

function checkDate(date) {
  if (!isIsoDate(date)) throw new ServiceError(400, 'date must be an ISO date (YYYY-MM-DD)');
  return date;
}

// Private companies by value held as of D: funds, value, the firms holding it,
// tracked or not. categories: only those kinds of company (default: every one).
function topCompanies(
  db,
  { date = newestReportDate(db), limit = 100, trackedOnly = false, categories, knownAsOf } = {}
) {
  checkDate(date);
  const known = knownOf(knownAsOf, date);
  const all = memo(db, `top:${date}${known ? `:known:${known}` : ''}`, () =>
    db
      .prepare(
        `WITH ${activeFilings(false, !!known)}
         SELECT c.id companyId, c.name, c.category, (t.company_id IS NOT NULL) tracked,
           COUNT(DISTINCT a.fund_key) funds,
           SUM(h.value_usd) value, MIN(a.report_date) oldestMark, MAX(a.report_date) newestMark,
           SUM(CASE WHEN h.via_spv = 1 OR h.instrument_type = 'indirect' THEN h.value_usd ELSE 0 END) indirectValue
         FROM active a JOIN holdings h ON h.accession = a.accession
         JOIN companies c ON c.id = h.company_id AND c.status = 'private'
         LEFT JOIN tracked_companies t ON t.company_id = c.id
         WHERE ${COUNTS}
         GROUP BY c.id ORDER BY value DESC`
      )
      .all(known ? { date, known } : { date })
      .map(r => ({ ...r, tracked: !!r.tracked }))
  );
  const ids = categoryIds(db, categories);
  // ranked within the list asked for, so an operating-companies view reads 1, 2, 3 (review 2026-10-15 T2)
  const list = all
    .filter(r => (!trackedOnly || r.tracked) && (!ids || ids.has(r.companyId)))
    .map((r, i) => ({ rank: i + 1, ...r }));
  return {
    date,
    ...(known ? { knownAsOf: known } : {}),
    ...(ids ? { categories } : {}),
    companies: list.length,
    totalValue: list.reduce((s, r) => s + r.value, 0),
    // the newest mark date in force among these funds, over every row (not just the page)
    newestMark: list.reduce((m, r) => (m === null || r.newestMark > m ? r.newestMark : m), null),
    results: list.slice(0, limit),
  };
}

// The newest mark date of any private holding in force as of the newest report
// date: what "newest mark" means on screen. The newest report date itself can be
// later (a fund whose newest filing holds no private company), so it never stands
// in for mark freshness (review 2026-10-15 T1).
function newestPrivateMark(db) {
  const date = newestReportDate(db);
  return date ? topCompanies(db, { date, limit: 1 }).newestMark : null;
}

// Private-company value by the issuer country the filings report (99.3% of
// tracked rows carry one); blank countries are "Unknown".
function countries(db, { date = newestReportDate(db) } = {}) {
  checkDate(date);
  return memo(db, `countries:${date}`, () => ({
    date,
    results: db
      .prepare(
        `WITH ${activeFilings(false)}
         SELECT COALESCE(NULLIF(h.country, ''), 'Unknown') country, COUNT(DISTINCT h.company_id) companies,
           COUNT(DISTINCT a.fund_key) funds, SUM(h.value_usd) value
         FROM active a JOIN holdings h ON h.accession = a.accession
         JOIN companies c ON c.id = h.company_id AND c.status = 'private'
         WHERE ${COUNTS}
         GROUP BY 1 ORDER BY value DESC`
      )
      .all({ date }),
  }));
}

// What is new: position changes in private companies in every canonical filing
// made from `since` (filing date) on, newest first. Tracked companies only
// unless all = true. At most 92 days per request.
// funds: a Set of fund keys (the scope's firm and fund filters), or null.
// Paged (staff review F16): `total` and `breakdown` (events by type, mark moves
// apart) cover every match; `events` is one page (offset, limit).
function feed(db, { since, until, all = false, types, funds = null, limit = 3000, offset = 0 } = {}) {
  const newest = db.prepare('SELECT MAX(filing_date) d FROM filings').get().d;
  const to = until || newest;
  const from = since || new Date(Date.parse(to) - 7 * 86400000).toISOString().slice(0, 10);
  checkDate(from);
  checkDate(to);
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92)
    throw new ServiceError(400, 'at most 92 days per feed request');
  const events = memo(db, `feed:${from}:${to}`, () => fundChanges(db, { filedSince: from, filedUntil: to }));
  const tracked = new Set(
    db
      .prepare('SELECT company_id FROM tracked_companies')
      .all()
      .map(r => r.company_id)
  );
  const kept = events.filter(
    e => (all || tracked.has(e.companyId)) && (!types || types.includes(e.type)) && (!funds || funds.has(e.fundKey))
  );
  const breakdown = {};
  for (const e of kept) {
    const k = e.label === 'mark moved' ? 'markMoved' : e.type;
    breakdown[k] = (breakdown[k] || 0) + 1;
  }
  const page = kept.slice(offset, offset + limit);
  return {
    since: from,
    until: to,
    scope: all ? 'all reviewed private companies' : 'tracked companies',
    count: kept.length,
    total: kept.length,
    breakdown,
    offset,
    limit,
    truncated: offset > 0 || offset + page.length < kept.length,
    events: page.map(e => ({ ...e, tracked: tracked.has(e.companyId) })),
  };
}

module.exports = {
  topCompanies,
  countries,
  feed,
  activeFilings,
  knownOf,
  COUNTS,
  newestReportDate,
  newestPrivateMark,
  CATEGORIES,
  categoryIds,
};
