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

// The rows that count toward exposure (lib/analytics/asof.js countsRule and
// EQUITY_BY.instrument_type, nullBalance true).
const COUNTS = `h.instrument_type IN ('equity','indirect','derivative') AND h.value_usd > 0
  AND (h.balance > 0 OR h.balance IS NULL OR h.balance = 0)`;

// Each active fund's filing as of @date (optionally only @funds, a JSON array).
const activeFilings = funds => `
  latest AS (
    SELECT fund_key, MAX(report_date) d FROM filings
    WHERE report_date <= @date ${funds ? 'AND fund_key IN (SELECT value FROM json_each(@funds))' : ''}
    GROUP BY fund_key HAVING julianday(@date) - julianday(MAX(report_date)) <= ${INACTIVE_DAYS}),
  active AS (
    SELECT c.accession, c.fund_key, c.report_date FROM canonical_filings c
    JOIN latest l ON l.fund_key = c.fund_key AND c.report_date = l.d)`;

function newestReportDate(db) {
  return db.prepare('SELECT MAX(as_of) d FROM company_stats').get().d;
}

function checkDate(date) {
  if (!isIsoDate(date)) throw new ServiceError(400, 'date must be an ISO date (YYYY-MM-DD)');
  return date;
}

// Private companies by value held as of D: funds, value, the firms holding it,
// tracked or not.
function topCompanies(db, { date = newestReportDate(db), limit = 100, trackedOnly = false } = {}) {
  checkDate(date);
  const all = memo(db, `top:${date}`, () =>
    db
      .prepare(
        `WITH ${activeFilings(false)}
         SELECT c.id companyId, c.name, (t.company_id IS NOT NULL) tracked, COUNT(DISTINCT a.fund_key) funds,
           SUM(h.value_usd) value, MIN(a.report_date) oldestMark, MAX(a.report_date) newestMark,
           SUM(CASE WHEN h.via_spv = 1 OR h.instrument_type = 'indirect' THEN h.value_usd ELSE 0 END) indirectValue
         FROM active a JOIN holdings h ON h.accession = a.accession
         JOIN companies c ON c.id = h.company_id AND c.status = 'private'
         LEFT JOIN tracked_companies t ON t.company_id = c.id
         WHERE ${COUNTS}
         GROUP BY c.id ORDER BY value DESC`
      )
      .all({ date })
      .map((r, i) => ({ rank: i + 1, ...r, tracked: !!r.tracked }))
  );
  const list = trackedOnly ? all.filter(r => r.tracked) : all;
  return {
    date,
    companies: list.length,
    totalValue: list.reduce((s, r) => s + r.value, 0),
    results: list.slice(0, limit),
  };
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
function feed(db, { since, until, all = false, types, funds = null, limit = 3000 } = {}) {
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
  return {
    since: from,
    until: to,
    scope: all ? 'all reviewed private companies' : 'tracked companies',
    count: kept.length,
    events: kept.slice(0, limit).map(e => ({ ...e, tracked: tracked.has(e.companyId) })),
  };
}

module.exports = { topCompanies, countries, feed, activeFilings, COUNTS, newestReportDate };
