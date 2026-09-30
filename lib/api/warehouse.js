// Warehouse routes (ROADMAP §5a task 6, ADR 0008). Read-only: the server
// opens warehouse.db with openWarehouseReadOnly; only jobs migrate or write.
// Every answer carries `source` and `refreshId` (the latest refresh_runs id).
// The ETag is the refresh id plus the build (APP_BUILD, else the server's start
// time): an answer changes when the data or the code does, so a cache or CDN
// can keep it until the next refresh or deploy. No
// route here makes an SEC request: listed companies and debt answer with
// source 'live' and the query the live path should run.
const express = require('express');
const { search } = require('../services/search');
const company = require('../services/company');
const fund = require('../services/fund');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isoDate = (name, v) => {
  if (v == null || v === '') return undefined;
  if (!ISO_DATE.test(String(v)) || Number.isNaN(Date.parse(v)))
    throw new HttpError(400, `${name} must be an ISO date (YYYY-MM-DD)`);
  return String(v);
};

function freshness(db) {
  const run = db
    .prepare("SELECT id, finished_at, status FROM refresh_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1")
    .get();
  const bulk = db
    .prepare("SELECT quarter FROM ingest_log WHERE kind = 'bulk' AND status = 'ok' ORDER BY quarter DESC LIMIT 1")
    .get();
  return {
    refreshId: run?.id ?? 0,
    refreshedAt: run?.finished_at ?? null,
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
      const { refreshId } = freshness(d);
      const etag = `W/"r${refreshId}-${build}"`;
      res.set({ ETag: etag, 'Cache-Control': 'no-cache' });
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      const out = fn(d, req, res);
      if (out === undefined) return undefined;
      return res.json({ source: 'warehouse', refreshId, ...out });
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

  const unreviewedRef = (d, req) => {
    const e = company.findUnreviewed(d, req.params.key);
    if (!e) throw new HttpError(404, `no unreviewed name "${req.params.key}"`);
    return e;
  };

  // Listed companies and debt: no warehouse numbers, the live path's query instead.
  const liveAnswer = (src, name) => ({ source: 'live', reason: src.reason, liveQuery: name });

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
      return { query: q, results: search(d, q, { limit }) };
    })
  );

  router.get(
    '/companies/:id',
    route((d, req, res) => {
      const c = companyRef(d, req, res);
      if (!c) return undefined;
      return {
        company: c,
        stats: company.statsOf(d, c.id),
        brands: company.brandsOf(d, c.id),
        answeredBy: company.sourceFor({ company: c }),
      };
    })
  );

  router.get(
    '/companies/:id/exposure',
    route((d, req, res) => {
      const c = companyRef(d, req, res);
      if (!c) return undefined;
      const src = company.sourceFor({ company: c });
      if (src.source === 'live') return { company: c, ...liveAnswer(src, c.name) };
      const date = isoDate('date', req.query.date) || freshness(d).newestReportDate;
      const knownAsOf = isoDate('knownAsOf', req.query.knownAsOf);
      return { company: c, ...company.exposure(d, { companyId: c.id }, date, { knownAsOf }) };
    })
  );

  router.get(
    '/companies/:id/history',
    route((d, req, res) => {
      const c = companyRef(d, req, res);
      if (!c) return undefined;
      const src = company.sourceFor({ company: c });
      if (src.source === 'live') return { company: c, ...liveAnswer(src, c.name) };
      return { company: c, ...company.history(d, { companyId: c.id }) };
    })
  );

  router.get(
    '/entities/:key',
    route((d, req) => {
      const e = unreviewedRef(d, req);
      return { entity: e, label: company.LABEL.unreviewed, answeredBy: company.sourceFor({ unreviewed: e }) };
    })
  );

  router.get(
    '/entities/:key/exposure',
    route((d, req) => {
      const e = unreviewedRef(d, req);
      const src = company.sourceFor({ unreviewed: e });
      if (src.source === 'live') return { entity: e, ...liveAnswer(src, e.name) };
      const date = isoDate('date', req.query.date) || freshness(d).newestReportDate;
      const knownAsOf = isoDate('knownAsOf', req.query.knownAsOf);
      return {
        entity: e,
        label: company.LABEL.unreviewed,
        ...company.exposure(d, { entityId: e.id }, date, { knownAsOf }),
      };
    })
  );

  router.get(
    '/entities/:key/history',
    route((d, req) => {
      const e = unreviewedRef(d, req);
      const src = company.sourceFor({ unreviewed: e });
      if (src.source === 'live') return { entity: e, ...liveAnswer(src, e.name) };
      return { entity: e, label: company.LABEL.unreviewed, ...company.history(d, { entityId: e.id }) };
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
      return { companies: ids.length, ms: Date.now() - t };
    } catch (err) {
      return { error: err.message };
    }
  };

  return router;
}

module.exports = { warehouseRouter, freshness };
