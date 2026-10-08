// Warehouse routes (ROADMAP §5a task 6, ADR 0008). Read-only: the server
// opens warehouse.db with openWarehouseReadOnly; only jobs migrate or write.
// Every answer carries `source` and `refreshId` (the latest refresh_runs id).
// The ETag is the refresh id plus the build (APP_BUILD, else the server's start
// time): an answer changes when the data or the code does, so a cache or CDN
// can keep it until the next refresh or deploy. No
// route here makes an SEC request: listed companies and debt answer with
// source 'live' and the query the live path should run.
const fs = require('fs');
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
const { generationOf } = require('../warehouse/db');
const { memo } = require('../services/memo');
const { jobState } = require('../warehouse/job-state');

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

// refreshId is the published generation the answer was read from
// (lib/warehouse/job.js; db.generationOf), so the ETag and every cache move
// exactly when readers switch to a new generation, and never while a job is
// still building one. refreshedAt is the last data refresh. The last job's
// state (running, failed, ...) is reported apart from the data version.
const lastRunId = db => generationOf(db);
const freshnessMemo = new WeakMap();
function freshness(db) {
  const id = lastRunId(db);
  let f = freshnessMemo.get(db);
  if (f?.refreshId !== id) freshnessMemo.set(db, (f = computeFreshness(db, id)));
  return { ...f, job: jobOf(db) };
}
const jobOf = db => {
  if (!db.name || db.memory) return null;
  const j = jobState(db.name);
  return (
    j && {
      kind: j.kind,
      status: j.status,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt ?? null,
      error: j.error ?? null,
      // a published job's post-commit or validation warnings (Codex verification V05)
      warning: j.warning ?? null,
    }
  );
};
function computeFreshness(db, id) {
  const refreshed = db
    .prepare(
      "SELECT finished_at FROM refresh_runs WHERE status IN ('ok', 'partial') AND kind = 'refresh' ORDER BY id DESC LIMIT 1"
    )
    .get();
  const bulk = db
    .prepare("SELECT quarter FROM ingest_log WHERE kind = 'bulk' AND status = 'ok' ORDER BY quarter DESC LIMIT 1")
    .get();
  let meta = null;
  try {
    meta = db
      .prepare('SELECT created_at, curation_rev, curation_digest, code_rev, status FROM generation_meta WHERE id = ?')
      .get(id);
  } catch {
    // before migration 0020
  }
  return {
    refreshId: id,
    refreshedAt: refreshed?.finished_at ?? null,
    newestFilingDate: db.prepare('SELECT MAX(filing_date) d FROM filings').get().d,
    newestReportDate: db.prepare('SELECT MAX(as_of) d FROM company_stats').get().d,
    latestBulkQuarter: bulk?.quarter ?? null,
    generation: meta
      ? {
          id,
          publishedAt: meta.created_at,
          status: meta.status,
          curationRev: meta.curation_rev,
          // sha256 of the exact reviewed files the data reflects (review R18); null
          // until a curation job has run on migration 0021
          curationDigest: meta.curation_digest ?? null,
          codeRev: meta.code_rev,
        }
      : null,
  };
}

// How cross-company answers read history (staff review F14): which companies
// are private, and which firm a fund belongs to, are today's reviewed list and
// each fund's current N-CEN adviser, applied to every period. Said on every
// market, analysis, firm, watchlist and feed answer (and their exports in the app).
const BASIS_ROUTES = /^\/(market|analysis|firms|watchlist|feed)(\/|$)/;
function basisOf(d) {
  const g = freshness(d).generation;
  return {
    generation: g?.id ?? null,
    curationRev: g?.curationRev ?? null,
    curationDigest: g?.curationDigest ?? null,
    companies: "private companies are today's reviewed list, applied to every period",
    firms: "a firm is each fund's current adviser (latest N-CEN), applied to every period",
  };
}

// openDb: () => a read-only better-sqlite3 handle (opened once, lazily).
// warmOnSwitch: warm a new generation before serving it (the server; P8 W3:
// every cache is keyed on the generation, so after each nightly refresh the
// first visitors paid up to 1.5 s for the firm list). The old generation keeps
// answering while the new one warms; then one synchronous swap (P9).
// warmDelayMs: wait this long before warming a new generation, so two
// instances behind one balancer are never both warming (VANTAGE_WARM_DELAY_MS).
function warehouseRouter(
  openDb,
  {
    build = process.env.APP_BUILD || Date.now().toString(36),
    warmOnSwitch = false,
    warmDelayMs = Number(process.env.VANTAGE_WARM_DELAY_MS) || 0,
    cdnMaxAge = Number(process.env.VANTAGE_CDN_MAX_AGE) || 0,
  } = {}
) {
  const router = express.Router();
  let db = null;
  let opened = null; // the generation file the handle reads
  let switching = null; // a new generation opening and warming in the background
  let warmedOnce = false; // the first warm-up finished (readiness, P9)
  // The file behind a handle's path: a published generation through the
  // warehouse.db link (job.js), or the file itself; null for an in-memory db.
  const fileOf = name => {
    try {
      return name && name !== ':memory:' ? fs.realpathSync(name) : null;
    } catch {
      return null;
    }
  };
  // Opens lazily; when a job has published a new generation (the link now
  // points at another file), the next request switches to it. Without
  // warmOnSwitch the old handle closes at once (every route is synchronous, so
  // no request is still reading it); with it, see switchTo.
  const handle = () => {
    if (db && opened && fileOf(db.name) !== opened) {
      if (warmOnSwitch) {
        switchTo();
        return db;
      }
      db.close();
      db = null;
    }
    if (!db) {
      try {
        db = openDb();
      } catch (err) {
        throw new HttpError(503, `warehouse unavailable: ${err.message}`);
      }
      opened = fileOf(db.name);
    }
    return db;
  };
  // Opens the new generation beside the old one, waits warmDelayMs, warms the
  // new handle (yielding, so requests keep being answered from the old one),
  // then swaps in one step and closes the old handle. One switch at a time; a
  // generation published during a switch is picked up on the next request.
  // Never throws: a failed open keeps serving the old generation, logged.
  const switchTo = () =>
    (switching ??= (async () => {
      // start on the next tick, so `switching` is set before the finally below
      // clears it (an open that throws at once would otherwise leave it set)
      await null;
      let next = null;
      try {
        next = openDb();
        // the file this handle reads (a later generation published meanwhile
        // is switched to after this one)
        const nextFile = fileOf(next.name);
        if (warmDelayMs > 0) await new Promise(resolve => setTimeout(resolve, warmDelayMs).unref?.());
        const w = await warmOnce(next);
        const old = db;
        db = next;
        opened = nextFile;
        next = null;
        if (old && old !== db) old.close();
        return w;
      } catch (err) {
        console.error('warehouse switch failed; serving the previous generation:', err.message);
        return { error: err.message };
      } finally {
        if (next) next.close();
        switching = null;
      }
    })());
  // A new generation behind the link, checked without a request (the server
  // polls this, so an idle instance switches too).
  router.checkSwitch = () => {
    if (db && opened && fileOf(db.name) !== opened) return warmOnSwitch ? switchTo() : (handle(), null);
    return switching;
  };
  // What /readyz reports (P9). ready: this process can answer from a warmed
  // warehouse (a balancer or a deploy waits for it). fresh: also the last data
  // refresh finished within maxAgeHours and the last job did not fail (an uptime
  // monitor checks it; a deploy does not, so stale data never blocks a fix).
  router.readiness = ({ maxAgeHours = 48, now = Date.now() } = {}) => {
    let d;
    try {
      d = handle();
    } catch (err) {
      return { ready: false, fresh: false, reason: err.message };
    }
    const f = freshness(d);
    const ageHours = f.refreshedAt ? Math.round(((now - Date.parse(f.refreshedAt)) / 3600000) * 10) / 10 : null;
    const jobFailed = ['failed', 'interrupted'].includes(f.job?.status);
    const stale = ageHours == null || ageHours > maxAgeHours;
    const reason = !warmedOnce
      ? 'warming up'
      : stale
        ? `last refresh ${ageHours == null ? 'unknown' : `${ageHours} h ago`} (limit ${maxAgeHours} h)`
        : jobFailed
          ? `last job ${f.job.status}`
          : null;
    return {
      ready: warmedOnce,
      fresh: warmedOnce && !stale && !jobFailed,
      reason,
      generation: f.refreshId,
      switching: !!switching,
      refreshedAt: f.refreshedAt,
      refreshAgeHours: ageHours,
      newestFilingDate: f.newestFilingDate,
      newestReportDate: f.newestReportDate,
      job: f.job && { kind: f.job.kind, status: f.job.status, finishedAt: f.job.finishedAt },
    };
  };

  // Browsers always revalidate (the ETag makes that a 304). cdnMaxAge (public
  // deployment, P9): a shared cache (Cloudflare) may also serve the answer for
  // that many seconds without asking, so repeat views of one page across many
  // visitors cost the origin nothing; a new generation is a new ETag, and the
  // client asks again for an answer older than one it has seen (web/src/api/client.ts).
  const cacheControl =
    cdnMaxAge > 0 ? `public, max-age=0, must-revalidate, s-maxage=${Math.floor(cdnMaxAge)}` : 'no-cache';

  // Wraps a handler: opens the db, sets the envelope, ETag and errors.
  // { etag: false } for an answer that changes without a new generation
  // (/freshness reports the last job's state, review R08): never a 304.
  const route =
    (fn, { etag: conditional = true } = {}) =>
    (req, res) => {
      try {
        const d = handle();
        const refreshId = lastRunId(d);
        const etag = `W/"r${refreshId}-${build}"`;
        if (conditional) {
          res.set({ ETag: etag, 'Cache-Control': cacheControl });
          if (req.headers['if-none-match'] === etag) return res.status(304).end();
        } else res.set('Cache-Control', 'no-store');
        const out = fn(d, req, res);
        if (out === undefined) return undefined;
        const extra = BASIS_ROUTES.test(req.path) ? { basis: basisOf(d) } : {};
        return sendJson(req, res, { source: 'warehouse', refreshId, ...extra, ...out });
      } catch (err) {
        const status = err.status || 500;
        // an error is never kept by a browser or the CDN
        res.removeHeader('ETag');
        res.set('Cache-Control', 'no-store');
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
    route(d => freshness(d), { etag: false })
  );

  // What the warehouse holds, for the About and Status pages (P9): counts read
  // straight from the tables of the published generation.
  router.get(
    '/stats',
    route(d => ({ stats: warehouseStats(d) }))
  );

  // Link previews and the sitemap (P9): the server writes each page's title
  // and description into the HTML, because link crawlers (LinkedIn, Slack) do
  // not run JavaScript. path: a workspace URL path. null: no warehouse, so the
  // default head; { notFound: true }: no such company, fund or firm.
  router.pageMeta = path => {
    let d;
    try {
      d = handle();
    } catch {
      return null;
    }
    return pageMetaOf(d, path);
  };
  router.sitemapEntries = () => {
    let d;
    try {
      d = handle();
    } catch {
      return null;
    }
    return memo(d, 'sitemap', () => ({
      companies: d
        .prepare(
          `SELECT c.id, c.name, s.as_of FROM companies c JOIN company_stats s ON s.company_id = c.id
           WHERE c.status = 'private' AND s.current_value_usd > 0 ORDER BY s.current_value_usd DESC`
        )
        .all(),
      firms: firm
        .firms(d, {})
        .results.filter(f => f.value > 0)
        .map(f => ({ id: f.id })),
    }));
  };

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
  // ?date=: read history only through that date, like the tracked dashboard
  // (Codex verification V08); without it, the newest report date.
  view('stale', (d, ref, req) =>
    marks.staleMarks(d, ref, {
      minReports: Math.min(Math.max(Number(req.query.min) || 3, 2), 20),
      asOf: isoDate('date', req.query.date),
    })
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
  // Mark leadership: per class, which firm first reported each new per-share level, by mark date (?instrument= one class).
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
  // Movers and newly reported companies over a window of mark dates (P6b W4).
  router.get(
    '/market/movers',
    route((d, req) =>
      analysis.movers(d, {
        from: isoDate('from', req.query.from),
        to: isoDate('to', req.query.to),
        tracked: req.query.tracked === '1',
        limit: Math.min(Math.max(Number(req.query.limit) || 25, 1), 100),
      })
    )
  );
  router.get(
    '/market/new',
    route((d, req) =>
      analysis.newlyReported(d, { from: isoDate('from', req.query.from), to: isoDate('to', req.query.to) })
    )
  );
  // The watchlist's numbers (the list itself lives in the browser): ?company=1,5&firm=9&fund=S000009228.
  router.get(
    '/watchlist',
    route((d, req) => {
      const items = {};
      for (const kind of ['company', 'firm', 'fund']) {
        const keys = typesParam(req.query[kind]) || [];
        if (keys.length > 100) throw new HttpError(400, 'at most 100 items of each kind');
        items[kind] = kind === 'fund' ? keys.map(k => k.toUpperCase()) : keys.map(Number);
        if (kind !== 'fund' && items[kind].some(n => !Number.isInteger(n) || n < 1))
          throw new HttpError(400, `${kind} must be ids`);
      }
      return analysis.watchlist(d, { items, date: isoDate('date', req.query.date) });
    })
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
      const scope = scopeOf(req);
      if (scopes.needsSubject(scope)) throw new HttpError(400, 'the feed takes firm and fund filters only');
      const f = market.feed(d, {
        funds: scopes.fundsInScope(d, scope),
        since: isoDate('since', req.query.since),
        until: isoDate('until', req.query.until),
        all: req.query.all === '1',
        types: typesParam(req.query.types),
        // one page at a time (default and most 3,000); total and breakdown cover every match
        limit: Math.min(Math.max(Number(req.query.limit) || 3000, 1), 3000),
        offset: Math.max(Number(req.query.offset) || 0, 0),
      });
      return { ...f, filters: scopes.describe(scope), events: fundLabelled(f.events) };
    })
  );
  router.get(
    '/firms',
    route((d, req) => firm.firms(d, { date: isoDate('date', req.query.date), q: req.query.q }))
  );
  // A firm id. Ids are permanent (manager_ids.csv, F08): a retired one answers
  // 301 to its successor, or 410 when the firm was dropped; null = redirected.
  const firmId = (d, req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'firm id must be a positive integer');
    const r = firm.firmRedirect(d, id);
    if (!r) return id;
    if (r.to == null) throw new HttpError(410, `firm ${id} (${r.name}) was dropped from the reviewed list`);
    res.redirect(301, req.originalUrl.replace(/^(.*\/firms\/)\d+/, `$1${r.to}`));
    return null;
  };
  router.get(
    '/firms/:id',
    route((d, req, res) => {
      const id = firmId(d, req, res);
      return id == null ? undefined : firm.firmBook(d, id, { date: isoDate('date', req.query.date) });
    })
  );
  router.get(
    '/firms/:id/changes',
    route((d, req, res) => {
      const id = firmId(d, req, res);
      if (id == null) return undefined;
      return firm.firmChanges(d, id, {
        since: isoDate('since', req.query.since),
        until: isoDate('until', req.query.until),
        types: typesParam(req.query.types),
        companyId: req.query.company ? Number(req.query.company) : undefined,
        // One page at a time (default 500, at most 2,000); ?limit=0 is not allowed.
        limit: Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000),
        offset: Math.max(Number(req.query.offset) || 0, 0),
      });
    })
  );
  router.get(
    '/firms/:id/marks/:companyId',
    route((d, req, res) => {
      const c = Number(req.params.companyId);
      if (!Number.isInteger(c) || c < 1) throw new HttpError(400, 'company id must be a positive integer');
      const id = firmId(d, req, res);
      return id == null ? undefined : firm.firmMarks(d, id, c);
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
        tracked: req.query.tracked === '1',
      });
      return { ...subject, ...p };
    })
  );
  // The legs behind one pivot cell: the same rows, scope and subject, one row
  // key (none = the total row), one metric and the cell's period (from, to].
  router.get(
    '/analysis/drill',
    route((d, req) => {
      const { ref, subject } = subjectOf(d, req);
      const r = analysis.drill(d, {
        ref,
        scope: scopeOf(req),
        rows: req.query.rows ? String(req.query.rows) : undefined,
        key: req.query.key != null ? String(req.query.key) : null,
        metric: req.query.metric ? String(req.query.metric) : undefined,
        from: isoDate('from', req.query.from),
        to: isoDate('to', req.query.to),
        tracked: req.query.tracked === '1',
        limit: Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000),
      });
      return { ...subject, ...r };
    })
  );
  // Compare 2-5 companies, firms, funds or classes (?rows=company&key=1&key=5&key=6).
  router.get(
    '/analysis/compare',
    route((d, req) =>
      analysis.compare(d, {
        rows: req.query.rows ? String(req.query.rows) : undefined,
        keys: [req.query.key ?? []].flat().map(String).filter(Boolean),
        period: req.query.period ? String(req.query.period) : undefined,
        from: isoDate('from', req.query.from),
        to: isoDate('to', req.query.to),
      })
    )
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
  // companies so requests are served meanwhile. Never throws. One at a time:
  // a call while one runs gets the running one.
  // A switch in progress is the warm-up of the generation being switched to.
  let warming = null;
  router.warm = () =>
    switching ??
    (warming ??= warmOnce().finally(() => {
      warming = null;
      warmedOnce = true;
    }));
  const WARM_FIRMS = 12; // the largest firms' change pages (cold 200-300 ms each, P8 W3)
  // d: the handle to warm (a generation being switched to), else the current one.
  const warmOnce = async target => {
    try {
      const d = target ?? handle();
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
      const top = firm.firms(d, { date }).results.slice(0, WARM_FIRMS);
      await new Promise(resolve => setImmediate(resolve));
      for (const f of top) {
        firm.firmChanges(d, f.id, { limit: 1 });
        await new Promise(resolve => setImmediate(resolve));
      }
      trackedDashboard(d, { date });
      await new Promise(resolve => setImmediate(resolve));
      analysis.allFacts(d);
      analysis.marksByDate(d);
      return { companies: ids.length, firms: top.length, generation: lastRunId(d), ms: Date.now() - t };
    } catch (err) {
      return { error: err.message };
    }
  };

  return router;
}

// Counts for the About and Status pages, once per generation.
function warehouseStats(db) {
  return memo(db, 'stats', () => {
    const one = sql => db.prepare(sql).get();
    const f = one('SELECT COUNT(*) n, MIN(filing_date) first, MAX(filing_date) last FROM filings');
    return {
      filings: f.n,
      firstFilingDate: f.first,
      newestFilingDate: f.last,
      funds: one('SELECT COUNT(DISTINCT fund_key) n FROM filings').n,
      privateCompanies: one("SELECT COUNT(*) n FROM companies WHERE status = 'private'").n,
      trackedCompanies: one('SELECT COUNT(*) n FROM tracked_companies').n,
      firms: one('SELECT COUNT(*) n FROM managers').n,
      newestReportDate: one('SELECT MAX(as_of) d FROM company_stats').d,
    };
  });
}

const money = v =>
  v >= 1e9
    ? `$${(v / 1e9).toFixed(2)}B`
    : v >= 1e6
      ? `$${(v / 1e6).toFixed(1)}M`
      : `$${Math.round(v).toLocaleString('en-US')}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateLabel = iso =>
  iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}` : '';

// { title, description } for a workspace path, { notFound: true }, or null (the
// default head). The numbers are the company's stored stats (company_stats,
// equal to exposureAsOf at the newest report date), as its page shows them.
function pageMetaOf(db, path) {
  const m = /^\/(company|fund|firm)\/([^/?#]+)\/?$/.exec(path);
  if (!m) return null;
  const [, kind, raw] = m;
  let ref;
  try {
    ref = decodeURIComponent(raw);
  } catch {
    return { notFound: true };
  }
  if (kind === 'company') {
    const id = Number(/^(\d+)(?:-|$)/.exec(ref)?.[1]);
    if (!Number.isInteger(id) || id < 1) return { notFound: true };
    const found = company.findCompany(db, id);
    const c = found?.redirect
      ? found.redirect.to
        ? company.findCompany(db, found.redirect.to)?.company
        : null
      : found?.company;
    if (!c) return { notFound: true };
    const s = company.statsOf(db, c.id);
    const held =
      s && s.current_funds > 0
        ? `${s.current_funds} ${s.current_funds === 1 ? 'fund' : 'funds'} reported ${money(s.current_value_usd)} as of ${dateLabel(s.as_of)}. `
        : '';
    return {
      title: `${c.name}: fund holdings and marks`,
      description: `${c.name} in SEC N-PORT filings. ${held}Holdings, per-share marks and changes by fund, firm and share class, each linked to its filing.`,
    };
  }
  if (kind === 'fund') {
    const f = fund.findFund(db, ref);
    if (!f) return { notFound: true };
    const name = f.seriesName || f.registrant || f.fundKey;
    return {
      title: `${name}: private holdings`,
      description: `${name}${f.registrant && f.registrant !== name ? ` (${f.registrant})` : ''}: private-company holdings, marks and changes from its SEC N-PORT filings, ${dateLabel(f.firstReportDate)} to ${dateLabel(f.lastReportDate)}.`,
    };
  }
  const id = Number(ref);
  if (!Number.isInteger(id) || id < 1) return { notFound: true };
  const r = firm.firmRedirect(db, id);
  const row = db.prepare('SELECT id, name FROM managers WHERE id = ?').get(r ? (r.to ?? -1) : id);
  if (!row) return { notFound: true };
  return {
    title: `${row.name}: private-company book`,
    description: `${row.name}: private-company holdings across its funds, from SEC N-PORT filings and N-CEN advisers. Positions, marks and changes by company and fund.`,
  };
}

module.exports = { warehouseRouter, freshness, pageMetaOf, warehouseStats };
