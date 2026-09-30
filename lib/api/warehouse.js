// Warehouse routes (ROADMAP §5a task 6, ADR 0008). Read-only: the server
// opens warehouse.db with openWarehouseReadOnly; only jobs migrate or write.
// Every answer carries `source` and `refreshId` (the latest refresh_runs id,
// also the ETag), so a cache or CDN can keep it until the next refresh. No
// route here makes an SEC request: listed companies and debt answer with
// source 'live' and the query the live path should run.
const express = require('express');
const { search } = require('../services/search');
const company = require('../services/company');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
function warehouseRouter(openDb) {
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
      const etag = `W/"r${refreshId}"`;
      res.set({ ETag: etag, 'Cache-Control': 'no-cache' });
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      const out = fn(d, req, res);
      if (out === undefined) return undefined;
      return res.json({ source: 'warehouse', refreshId, ...out });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('warehouse route error:', err);
      return res.status(status).json({ error: status === 500 ? 'Internal error' : err.message });
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

  return router;
}

module.exports = { warehouseRouter, freshness };
