// Warehouse routes (ROADMAP §5a task 6, ADR 0008). Read-only: the server
// opens warehouse.db with openWarehouseReadOnly; only jobs migrate or write.
// Every answer carries `source` and `refreshId` (the latest refresh_runs id).
// The ETag is the refresh id plus the build (APP_BUILD, else the server's start
// time): an answer changes when the data or the code does, so a cache or CDN
// can keep it until the next refresh or deploy. No
// route here makes an SEC request: listed companies and debt answer with
// source 'live' and the query the live path should run.
const zlib = require('zlib');
const express = require('express');
const { search, unifiedSearch, SEARCH_KINDS } = require('../services/search');
const analysis = require('../services/analysis');
const scopes = require('../services/scope');
const company = require('../services/company');
const fund = require('../services/fund');
const market = require('../services/market');
const firm = require('../services/firm');
const marks = require('../services/marks');
const { trackedDashboard } = require('../services/dashboard');
const { companyActivity, activityByMonth, fundChanges } = require('../analytics/activity');
const { exposureSeries, monthEnds } = require('../analytics/asof');
const { ServiceError: HttpError, ACCESSION, isIsoDate } = require('../services/errors');

// Each fund's advising firms (current N-CEN adviser, as the firm book counts
// them; marks.firmsOfFund is the one definition), so a company's holders and
// changes can be read and filtered by manager.
function withFirms(db, list) {
  const firmsOf = marks.firmsOfFund(db);
  return list.map(x => ({ ...x, firms: firmsOf(x.fundKey) }));
}
// Positions also carry the class label the class views group by (marks.classOfRow:
// "F1" and "F-1" are one class), so a class picked there filters holders exactly.
function exposureWithFirms(db, e) {
  const classed = h => ({
    ...h,
    positions: h.positions?.map(p => ({ ...p, classLabel: marks.classOfRow(p) })),
  });
  return {
    ...e,
    holdings: withFirms(db, e.holdings.map(classed)),
    zeroValue: withFirms(db, e.zeroValue),
    exited: withFirms(db, e.exited),
    inactive: withFirms(db, e.inactive),
  };
}

const isoDate = (name, v) => {
  if (v == null || v === '') return undefined;
  if (!isIsoDate(String(v))) throw new HttpError(400, `${name} must be an ISO date (YYYY-MM-DD)`);
  return String(v);
};
// The analyst's scope from ?firm=&fund=&class=&kind= (services/scope.js).
// withScope(ref, scope): the company narrowed to it, for every answer built
// on its rows (asof.companyRows `only`).
const scopeOf = req => scopes.parseScope(req.query);
const withScope = (d, ref, scope) => {
  const only = scopes.rowPredicate(d, scope);
  return only ? { ...ref, only } : ref;
};
// Ranges a filing gives without naming vehicles have no class or kind; a fund
// or firm filter keeps those of its funds.
function scopedDisclosed(d, list, scope) {
  if (scopes.isEmpty(scope)) return list;
  if (scopes.needsSubject(scope)) return [];
  const funds = scopes.fundsInScope(d, scope);
  return list.filter(x => funds.has(x.fundKey));
}

// JSON over 2 KB goes gzipped when the client accepts it (a company history is
// ~1 MB of JSON, ~10x smaller compressed).
function sendJson(req, res, body) {
  const text = JSON.stringify(body);
  res.set('Vary', 'Accept-Encoding');
  if (text.length < 2048 || !req.acceptsEncodings('gzip')) return res.type('json').send(text);
  res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip' });
  return res.send(zlib.gzipSync(text, { level: 6 }));
}

// refreshId counts every finished run that changed the data (a refresh or an
// admin curation, migration 0018), so the ETag moves with either; refreshedAt
// is the last data refresh. Memoized per refresh id (the data cannot change
// without a new one).
const lastRunId = db =>
  db.prepare("SELECT id FROM refresh_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1").get()?.id ?? 0;
const freshnessMemo = new WeakMap();
function freshness(db) {
  const id = lastRunId(db);
  const memo = freshnessMemo.get(db);
  if (memo?.refreshId === id) return memo;
  const f = computeFreshness(db);
  freshnessMemo.set(db, f);
  return f;
}
function computeFreshness(db) {
  const run = db
    .prepare("SELECT id, finished_at, status FROM refresh_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1")
    .get();
  const refreshed = db
    .prepare("SELECT finished_at FROM refresh_runs WHERE status = 'ok' AND kind = 'refresh' ORDER BY id DESC LIMIT 1")
    .get();
  const bulk = db
    .prepare("SELECT quarter FROM ingest_log WHERE kind = 'bulk' AND status = 'ok' ORDER BY quarter DESC LIMIT 1")
    .get();
  return {
    refreshId: run?.id ?? 0,
    refreshedAt: refreshed?.finished_at ?? null,
    newestFilingDate: db.prepare('SELECT MAX(filing_date) d FROM filings').get().d,
    newestReportDate: db.prepare('SELECT MAX(as_of) d FROM company_stats').get().d,
    latestBulkQuarter: bulk?.quarter ?? null,
  };
}

// openDb: () => a read-only better-sqlite3 handle (opened once, lazily).
function warehouseRouter(openDb, { build = process.env.APP_BUILD || Date.now().toString(36) } = {}) {
  const router = express.Router();
  let db = null;
  const handle = () => {
    if (!db) {
      try {
        db = openDb();
      } catch (err) {
        throw new HttpError(503, `warehouse unavailable: ${err.message}`);
      }
    }
    return db;
  };

  // Wraps a handler: opens the db, sets the envelope, ETag and errors.
  const route = fn => (req, res) => {
    try {
      const d = handle();
      const refreshId = lastRunId(d);
      const etag = `W/"r${refreshId}-${build}"`;
      res.set({ ETag: etag, 'Cache-Control': 'no-cache' });
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      const out = fn(d, req, res);
      if (out === undefined) return undefined;
      return sendJson(req, res, { source: 'warehouse', refreshId, ...out });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('warehouse route error:', err);
      const body = { error: status === 500 ? 'Internal error' : err.message };
      if (err.replacedBy) body.replacedBy = err.replacedBy; // an amended filing (409)
      return res.status(status).json(body);
    }
  };

  const companyRef = (d, req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'company id must be a positive integer');
    const found = company.findCompany(d, id);
    if (!found) throw new HttpError(404, `no company ${id}`);
    if (found.redirect) {
      if (found.redirect.to == null)
        throw new HttpError(410, `company ${id} (${found.redirect.name}) was dropped from the reviewed list`);
      const rest = req.originalUrl.replace(/^(.*\/companies\/)\d+/, `$1${found.redirect.to}`);
      res.redirect(301, rest);
      return null;
    }
    return found.company;
  };

  // An unreviewed name; one a review has since resolved (made a company, or
  // joined to another component) answers 301 to where it went.
  const unreviewedRef = (d, req, res) => {
    const e = company.findUnreviewed(d, req.params.key);
    if (!e) throw new HttpError(404, `no unreviewed name "${req.params.key}"`);
    if (e.redirect) {
      const rest = req.originalUrl.replace(/^.*\/entities\/[^/?]+/, '');
      const base = req.originalUrl.slice(0, req.originalUrl.indexOf('/entities/'));
      const to =
        e.redirect.kind === 'company'
          ? `${base}/companies/${e.redirect.id}${rest}`
          : `${base}/entities/${encodeURIComponent(e.redirect.key)}${rest}`;
      res.redirect(301, to);
      return null;
    }
    return e;
  };

  // Listed companies and debt: no warehouse numbers, the live path's query
  // instead. A listed company's stored rows (its private-era marks, then
  // restricted or lock-up rows) answer only when asked for (?stored=1),
  // labeled, never as its current holdings (ADR 0008, F24).
  const liveAnswer = (src, name) => ({ source: 'live', reason: src.reason, liveQuery: name });
  const wantsStored = req => req.query.stored === '1' || req.query.stored === 'true';
  const storedNote = (d, c) => ({
    stored: {
      label: 'stored rows of a listed company',
      note:
        'The warehouse keeps private-candidate rows only: this company’s private-era marks and, after it listed, its ' +
        'restricted or lock-up rows. Funds that hold its listed stock are not in these rows; use the live path for them.',
      listing: c ? company.listingOf(d, c.id) : null,
    },
  });

  router.get(
    '/freshness',
    route(d => freshness(d))
  );

  router.get(
    '/search',
    route((d, req) => {
      const q = String(req.query.q || '').trim();
      if (!q) throw new HttpError(400, 'q is required');
      const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
      // ?kinds=company,entity,firm,fund,class: one ranked list over all of them (P6b).
      if (req.query.kinds != null) {
        const kinds = String(req.query.kinds)
          .split(',')
          .map(k => k.trim())
          .filter(Boolean);
        const bad = kinds.filter(k => !SEARCH_KINDS.includes(k));
        if (!kinds.length || bad.length) throw new HttpError(400, `kinds must be among ${SEARCH_KINDS.join(', ')}`);
        return { query: q, kinds, results: unifiedSearch(d, q, { kinds, limit }) };
      }
      return { query: q, results: search(d, q, { limit }) };
    })
  );

  router.get(
    '/companies/:id',
    route((d, req, res) => {
      const c = companyRef(d, req, res);
      if (!c) return undefined;
      const answeredBy = company.sourceFor({ company: c });
      return {
        company: c,
        stats: company.statsOf(d, c.id),
        brands: company.brandsOf(d, c.id),
        answeredBy,
        ...(answeredBy.source === 'live' ? storedNote(d, c) : {}),
      };
    })
  );

  router.get(
    '/companies/:id/exposure',
    route((d, req, res) => {
      const c = companyRef(d, req, res);
      if (!c) return undefined;
      const src = company.sourceFor({ company: c });
      const listed = src.source === 'live';
      if (listed && !wantsStored(req)) return { company: c, ...liveAnswer(src, c.name) };
      const date = isoDate('date', req.query.date) || freshness(d).newestReportDate;
      const knownAsOf = isoDate('knownAsOf', req.query.knownAsOf);
      const scope = scopeOf(req);
      const e = company.exposure(d, withScope(d, { companyId: c.id }, scope), date, { knownAsOf, listed });
      return {
        company: c,
        scope: scopes.describe(scope),
        ...(listed ? storedNote(d, c) : {}),
        ...exposureWithFirms(d, { ...e, disclosedExposure: scopedDisclosed(d, e.disclosedExposure, scope) }),
      };
    })
  );

  router.get(
    '/companies/:id/history',
    route((d, req, res) => {
      const c = companyRef(d, req, res);
      if (!c) return undefined;
      const src = company.sourceFor({ company: c });
      const listed = src.source === 'live';
      if (listed && !wantsStored(req)) return { company: c, ...liveAnswer(src, c.name) };
      const scope = scopeOf(req);
      return {
        company: c,
        scope: scopes.describe(scope),
        ...(listed ? storedNote(d, c) : {}),
        ...company.history(d, withScope(d, { companyId: c.id }, scope)),
      };
    })
  );

  router.get(
    '/entities/:key',
    route((d, req, res) => {
      const e = unreviewedRef(d, req, res);
      if (!e) return undefined;
      const answeredBy = company.sourceFor({ unreviewed: e });
      return {
        entity: e,
        label: company.LABEL.unreviewed,
        answeredBy,
        ...(answeredBy.source === 'live' ? storedNote(d, null) : {}),
      };
    })
  );

  router.get(
    '/entities/:key/exposure',
    route((d, req, res) => {
      const e = unreviewedRef(d, req, res);
      if (!e) return undefined;
      const src = company.sourceFor({ unreviewed: e });
      const listed = src.source === 'live';
      if (listed && !wantsStored(req)) return { entity: e, ...liveAnswer(src, e.name) };
      const date = isoDate('date', req.query.date) || freshness(d).newestReportDate;
      const knownAsOf = isoDate('knownAsOf', req.query.knownAsOf);
      const scope = scopeOf(req);
      return {
        entity: e,
        label: company.LABEL.unreviewed,
        scope: scopes.describe(scope),
        ...(listed ? storedNote(d, null) : {}),
        ...exposureWithFirms(
          d,
          company.exposure(d, withScope(d, { entityId: e.id }, scope), date, { knownAsOf, listed })
        ),
      };
    })
  );

  router.get(
    '/entities/:key/history',
    route((d, req, res) => {
      const e = unreviewedRef(d, req, res);
      if (!e) return undefined;
      const src = company.sourceFor({ unreviewed: e });
      const listed = src.source === 'live';
      if (listed && !wantsStored(req)) return { entity: e, ...liveAnswer(src, e.name) };
      const scope = scopeOf(req);
      return {
        entity: e,
        label: company.LABEL.unreviewed,
        scope: scopes.describe(scope),
        ...(listed ? storedNote(d, null) : {}),
        ...company.history(d, withScope(d, { entityId: e.id }, scope)),
      };
    })
  );

  // ── Company and unreviewed-name analytics (ROADMAP §6) ──
  // One route per view for both /companies/:id/… and /entities/:key/…; a
  // listed company answers them only with ?stored=1, labeled (as history).
  const targetOf = (d, req, res, kind) => {
    if (kind === 'company') {
      const c = companyRef(d, req, res);
      if (!c) return null;
      return {
        ref: { companyId: c.id },
        subject: { company: c },
        src: company.sourceFor({ company: c }),
        name: c.name,
        c,
      };
    }
    const e = unreviewedRef(d, req, res);
    if (!e) return null;
    return { ref: { entityId: e.id }, subject: { entity: e }, src: company.sourceFor({ unreviewed: e }), name: e.name };
  };
  const view = (path, fn) => {
    for (const kind of ['company', 'entity'])
      router.get(
        kind === 'company' ? `/companies/:id/${path}` : `/entities/:key/${path}`,
        route((d, req, res) => {
          const t = targetOf(d, req, res, kind);
          if (!t) return undefined;
          const listed = t.src.source === 'live';
          if (listed && !wantsStored(req)) return { ...t.subject, ...liveAnswer(t.src, t.name) };
          // fn(d, ref narrowed to the scope, req, { ref, scope }): the unnarrowed
          // ref and the scope for answers built on position facts.
          const scope = scopeOf(req);
          return {
            ...t.subject,
            scope: scopes.describe(scope),
            ...(listed ? storedNote(d, t.c) : {}),
            ...fn(d, withScope(d, t.ref, scope), req, { ref: t.ref, scope }),
          };
        })
      );
  };
  const firstMark = (d, ref) =>
    d
      .prepare(
        `SELECT MIN(f.report_date) d FROM holdings h JOIN filings f ON f.accession = h.accession
         WHERE ${ref.companyId != null ? 'h.company_id' : 'h.entity_id'} = ? AND h.value_usd > 0`
      )
      .get(ref.companyId ?? ref.entityId).d;
  const fundLabelled = events => {
    const labels = company.withFundLabels([...new Map(events.map(e => [e.fundKey, e])).values()]);
    const of = new Map(labels.map(f => [f.fundKey, f.label]));
    return events.map(e => ({ ...e, fundLabel: of.get(e.fundKey) }));
  };

  // Position changes per fund filing: first reported, added, reduced, no longer
  // reported, reported at $0, with mark moves; and their counts per month.
  view('activity', (d, ref, req) => {
    const events = companyActivity(d, ref, {
      since: isoDate('since', req.query.since),
      until: isoDate('until', req.query.until),
    });
    return { events: withFirms(d, fundLabelled(events)), byMonth: activityByMonth(events) };
  });
  // Funds holding and value at every month end since the first mark (as of
  // each date, the exposure rule), with funds entering and leaving.
  view('trend', (d, ref) => {
    const first = firstMark(d, ref);
    const to = freshness(d).newestReportDate;
    return { points: first ? exposureSeries(d, { ...ref, dates: monthEnds(first, to) }) : [] };
  });
  // Share classes as of a date: every fund's mark per class, spreads within a
  // mark date, and class gaps within one filing.
  view('classes', (d, ref, req) =>
    marks.classesAsOf(d, ref, isoDate('date', req.query.date) || freshness(d).newestReportDate)
  );
  // Per-share marks per class at every report date across all funds.
  view('marks', (d, ref) => marks.classMarks(d, ref));
  // Funds still filing an unchanged mark while the class's median moved.
  view('stale', (d, ref, req) =>
    marks.staleMarks(d, ref, { minReports: Math.min(Math.max(Number(req.query.min) || 3, 2), 20) })
  );
  // The bridge from `from` to `to` (default: the year to the newest report
  // date): start value, first reported, added, reduced, no longer reported,
  // mark moved, value only, started and stopped filing, end value (P6b W1).
  view('bridge', (d, _ref, req, { ref, scope }) =>
    analysis.bridge(d, { ref, scope, from: isoDate('from', req.query.from), to: isoDate('to', req.query.to) })
  );
  // Each fund's change at its latest filing as of ?date= (Holders' Δ columns).
  view('legs', (d, _ref, req, { ref, scope }) =>
    analysis.legsAt(d, ref, { scope, date: isoDate('date', req.query.date) })
  );
  // The stored rows behind every number, mark dates ?from..?to (Filings tab).
  view('rows', (d, ref, req) =>
    company.filingRows(d, ref, { from: isoDate('from', req.query.from), to: isoDate('to', req.query.to) })
  );
  // Mark leadership: per class, which firm first filed each new per-share level (?instrument= one class).
  view('leadership', (d, ref, req) =>
    marks.markLeadership(d, ref, { instrument: req.query.instrument ? String(req.query.instrument) : undefined })
  );
  // One fund's position in the company at every filing (?instrument= one key).
  view('positions/:fundKey', (d, _ref, req, { ref, scope }) =>
    analysis.positionHistory(d, ref, req.params.fundKey, {
      scope,
      instrumentKey: req.query.instrument ? String(req.query.instrument) : undefined,
    })
  );

  // An Atom feed of a company's position changes and mark moves (no account
  // needed): the newest 100 from the last 365 days of mark dates.
  const xml = v =>
    String(v ?? '').replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]
    );
  router.get(
    '/companies/:id/feed.xml',
    route((d, req, res) => {
      const c = companyRef(d, req, res);
      if (!c) return undefined;
      const newest = freshness(d).newestReportDate;
      const since = new Date(Date.parse(newest) - 365 * 86400000).toISOString().slice(0, 10);
      const events = fundLabelled(companyActivity(d, { companyId: c.id }, { since }))
        .sort((a, b) => b.filingDate.localeCompare(a.filingDate))
        .slice(0, 100);
      const pct = v => (v == null ? '' : ` (${v > 0 ? '+' : ''}${v.toFixed(1)}%)`);
      const self = `/api/companies/${c.id}/feed.xml`;
      const entries = events
        .map(e => {
          const url = `https://www.sec.gov/Archives/edgar/data/${e.cik}/${e.accession.replace(/-/g, '')}/`;
          const title = `${e.fundLabel}: ${e.label}${pct(e.markChangePct)}, mark date ${e.markDate}`;
          return `<entry><id>urn:vantage:${xml(e.accession)}:${c.id}</id><title>${xml(title)}</title><updated>${xml(e.filingDate)}T00:00:00Z</updated><link href="${xml(url)}"/><summary>${xml(`${c.name}. ${title}. Value $${Math.round(e.prevValue).toLocaleString('en-US')} -> $${Math.round(e.value).toLocaleString('en-US')}. Filed ${e.filingDate}, accession ${e.accession}. Source: SEC N-PORT.`)}</summary></entry>`;
        })
        .join('');
      res
        .type('application/atom+xml')
        .send(
          `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>urn:vantage:company:${c.id}</id><title>${xml(`Vantage: ${c.name} in N-PORT filings`)}</title><updated>${xml(events[0]?.filingDate || newest)}T00:00:00Z</updated><link rel="self" href="${xml(self)}"/>${entries}</feed>`
        );
      return undefined;
    })
  );

  // ── Market, feed and firms ──
  router.get(
    '/market/top',
    route((d, req) =>
      market.topCompanies(d, {
        date: isoDate('date', req.query.date),
        limit: Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000),
        trackedOnly: req.query.tracked === '1',
      })
    )
  );
  router.get(
    '/market/tracked',
    route((d, req) => trackedDashboard(d, { date: isoDate('date', req.query.date) }))
  );
  router.get(
    '/market/countries',
    route((d, req) => market.countries(d, { date: isoDate('date', req.query.date) }))
  );
  const typesParam = v =>
    v
      ? String(v)
          .split(',')
          .map(t => t.trim())
          .filter(Boolean)
      : undefined;
  router.get(
    '/feed',
    route((d, req) => {
      const f = market.feed(d, {
        since: isoDate('since', req.query.since),
        until: isoDate('until', req.query.until),
        all: req.query.all === '1',
        types: typesParam(req.query.types),
      });
      return { ...f, events: fundLabelled(f.events) };
    })
  );
  router.get(
    '/firms',
    route((d, req) => firm.firms(d, { date: isoDate('date', req.query.date), q: req.query.q }))
  );
  const firmId = req => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'firm id must be a positive integer');
    return id;
  };
  router.get(
    '/firms/:id',
    route((d, req) => firm.firmBook(d, firmId(req), { date: isoDate('date', req.query.date) }))
  );
  router.get(
    '/firms/:id/changes',
    route((d, req) =>
      firm.firmChanges(d, firmId(req), {
        since: isoDate('since', req.query.since),
        until: isoDate('until', req.query.until),
        types: typesParam(req.query.types),
        companyId: req.query.company ? Number(req.query.company) : undefined,
        // One page at a time (default 500, at most 2,000); ?limit=0 is not allowed.
        limit: Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000),
        offset: Math.max(Number(req.query.offset) || 0, 0),
      })
    )
  );
  router.get(
    '/firms/:id/marks/:companyId',
    route((d, req) => {
      const c = Number(req.params.companyId);
      if (!Number.isInteger(c) || c < 1) throw new HttpError(400, 'company id must be a positive integer');
      return firm.firmMarks(d, firmId(req), c);
    })
  );

  // ── Analysis across companies (P6b W1): bridge, pivot and timeline over the
  // position facts. ?company=<id> or ?entity=<key> narrows to one subject (a
  // listed company's stored rows only with ?stored=1); firm and fund filters
  // apply everywhere, class and kind with a subject.
  const subjectOf = (d, req) => {
    if (req.query.company != null && req.query.entity != null)
      throw new HttpError(400, 'pass company or entity, not both');
    if (req.query.company != null) {
      const id = Number(req.query.company);
      if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'company must be a positive integer');
      let found = company.findCompany(d, id);
      if (found?.redirect?.to != null) found = company.findCompany(d, found.redirect.to);
      if (!found?.company) throw new HttpError(404, `no company ${id}`);
      const c = found.company;
      if (company.sourceFor({ company: c }).source === 'live' && !wantsStored(req))
        throw new HttpError(400, `${c.name} is listed: add stored=1 for its stored rows`);
      return { ref: { companyId: c.id }, subject: { company: c } };
    }
    if (req.query.entity != null) {
      const e = company.findUnreviewed(d, req.query.entity);
      if (!e || e.redirect) throw new HttpError(404, `no unreviewed name "${req.query.entity}"`);
      return { ref: { entityId: e.id }, subject: { entity: e } };
    }
    return { ref: null, subject: {} };
  };
  router.get(
    '/analysis/bridge',
    route((d, req) => {
      const { ref, subject } = subjectOf(d, req);
      const b = analysis.bridge(d, {
        ref,
        scope: scopeOf(req),
        from: isoDate('from', req.query.from),
        to: isoDate('to', req.query.to),
      });
      return { ...subject, ...b };
    })
  );
  router.get(
    '/analysis/pivot',
    route((d, req) => {
      const { ref, subject } = subjectOf(d, req);
      const p = analysis.pivot(d, {
        ref,
        scope: scopeOf(req),
        rows: req.query.rows ? String(req.query.rows) : undefined,
        period: req.query.period ? String(req.query.period) : undefined,
        from: isoDate('from', req.query.from),
        to: isoDate('to', req.query.to),
        limit: Math.min(Math.max(Number(req.query.limit) || 50, 1), 1000),
      });
      return { ...subject, ...p };
    })
  );
  router.get(
    '/analysis/marks',
    route((d, req) => {
      if (req.query.firm != null) {
        const id = Number(req.query.firm);
        if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'firm must be a positive integer');
        return analysis.marksVsOthers(d, { firm: id, date: isoDate('date', req.query.date) });
      }
      if (req.query.fund != null) {
        const f = fund.findFund(d, String(req.query.fund));
        if (!f) throw new HttpError(404, `no fund "${req.query.fund}"`);
        return analysis.marksVsOthers(d, { fund: f.fundKey, date: isoDate('date', req.query.date) });
      }
      throw new HttpError(400, 'pass firm or fund');
    })
  );
  router.get(
    '/analysis/timeline',
    route((d, req) => {
      if (req.query.firm != null) {
        const id = Number(req.query.firm);
        if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'firm must be a positive integer');
        return { firmInfo: firm.findFirm(d, id), ...analysis.timeline(d, { firm: id }) };
      }
      if (req.query.fund != null) {
        const f = fund.findFund(d, String(req.query.fund));
        if (!f) throw new HttpError(404, `no fund "${req.query.fund}"`);
        return { fundInfo: f, ...analysis.timeline(d, { fund: f.fundKey }) };
      }
      throw new HttpError(400, 'pass firm or fund');
    })
  );

  // ── Funds (Fund X-Ray on the warehouse, ROADMAP §5b task 3) ──
  const accessionParam = (name, v) => {
    if (v == null || v === '') return undefined;
    const a = String(v).trim();
    if (!ACCESSION.test(a)) throw new HttpError(400, `${name} must be an accession like 0001193125-26-323081`);
    return a;
  };
  const fundRef = (d, req) => {
    const f = fund.findFund(d, req.params.key);
    if (!f) throw new HttpError(404, `no fund "${req.params.key}"`);
    return f;
  };

  router.get(
    '/funds',
    route((d, req) => {
      const q = String(req.query.q || '').trim();
      if (!q) throw new HttpError(400, 'q is required');
      const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
      return { query: q, results: fund.searchFunds(d, q, { limit }) };
    })
  );

  router.get(
    '/funds/:key',
    route((d, req) => {
      const f = fundRef(d, req);
      return { fund: f, filings: fund.fundFilings(d, f.fundKey) };
    })
  );

  router.get(
    '/funds/:key/xray',
    route((d, req) => {
      const f = fundRef(d, req);
      return {
        fund: f,
        xray: fund.forDisplay(fund.xray(d, f.fundKey, accessionParam('accession', req.query.accession))),
      };
    })
  );

  router.get(
    '/funds/:key/compare',
    route((d, req) => {
      const f = fundRef(d, req);
      return {
        fund: f,
        ...fund.compare(
          d,
          f.fundKey,
          accessionParam('current', req.query.current),
          accessionParam('prior', req.query.prior)
        ),
      };
    })
  );

  // The fund's position changes in private companies at every filing.
  router.get(
    '/funds/:key/changes',
    route((d, req) => {
      const f = fundRef(d, req);
      return { fund: f, events: fundChanges(d, { fundKeys: [f.fundKey] }) };
    })
  );

  router.get(
    '/funds/:key/returns',
    route((d, req) => {
      const f = fundRef(d, req);
      const accessions = String(req.query.accessions || '')
        .split(',')
        .map(a => a.trim())
        .filter(Boolean)
        .map(a => accessionParam('accessions', a));
      const n = Math.min(Math.max(Number(req.query.n) || 8, 2), fund.MAX_RETURN_FILINGS);
      return {
        fund: f,
        ...fund.returns(d, f.fundKey, { accessions, accession: accessionParam('accession', req.query.accession), n }),
      };
    })
  );

  // One pass over the tracked companies at the newest date on this connection,
  // so the first visitors don't pay for a cold cache (bench: 416 ms for a
  // fresh process's first exposure, under 25 ms after). Yields between
  // companies so requests are served meanwhile. Never throws.
  router.warm = async () => {
    try {
      const d = handle();
      const date = freshness(d).newestReportDate;
      const ids = d.prepare('SELECT company_id FROM tracked_companies').all();
      const t = Date.now();
      for (const { company_id: id } of ids) {
        company.exposure(d, { companyId: id }, date);
        await new Promise(resolve => setImmediate(resolve));
      }
      // The market-wide answers at the newest date, kept until the next refresh.
      market.topCompanies(d, { date });
      await new Promise(resolve => setImmediate(resolve));
      firm.firms(d, { date });
      await new Promise(resolve => setImmediate(resolve));
      trackedDashboard(d, { date });
      await new Promise(resolve => setImmediate(resolve));
      analysis.allFacts(d);
      analysis.marksByDate(d);
      return { companies: ids.length, ms: Date.now() - t };
    } catch (err) {
      return { error: err.message };
    }
  };

  return router;
}

module.exports = { warehouseRouter, freshness };
