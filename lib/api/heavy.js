// Guards for the warehouse API (2026-10-13 review F-05; 2026-10-14 review H1,
// H2, M1). The warehouse is read through better-sqlite3, which is synchronous:
// an uncached answer holds the whole process (a pivot over every month 0.8-1.2 s,
// the tracked dashboard at a new date was 4.8 s), and nothing else is answered
// meanwhile. Three limits keep one visitor from slowing the site for everyone:
//
//   1. a time budget per visitor on every API route: each answer's real time is
//      charged to the visitor who asked, and past VISITOR_MS_PER_MIN (15 s) of a
//      process's last minute the visitor's API requests answer 429. Cached
//      answers cost ~nothing, so a person clicking through pages never comes
//      near it, and a route that turns out slow is bounded without being listed;
//   2. a request count per visitor on the routes known to be heavy
//      (HEAVY_RATE_LIMIT_PER_MIN, 90), well above what pages need (1-4 a page);
//   3. load shedding: when API work has used more than HEAVY_BUSY_SHARE (0.6) of
//      the process's last 10 s, heavy routes answer 503 "busy" with Retry-After,
//      but only to visitors who have themselves used more than
//      BUSY_VISITOR_MS (2 s) this minute. A visitor who has asked for little
//      still gets an answer; the ones filling the process wait.
//
// Paths are matched case-insensitively (review H2: Express routed /API/... to
// the same handlers while this guard's pattern did not match it; the server is
// now case-sensitive too). Counters live in each process's memory: behind two
// instances a visitor can reach each instance's budget, and a restart clears it.
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

// The routes whose uncached answer can take over ~200 ms on the full warehouse:
// the count limit and load shedding apply to these. Every other API route is
// still bounded by the visitor's time budget, so a slow route left off this
// list costs its visitor, not the site.
const HEAVY =
  /^\/api\/(analysis\/[^/]+|feed|market\/(movers|new|tracked)|firms\/[^/]+\/changes|(companies|entities)\/[^/]+\/(rows|activity|legs|bridge|trend)|funds\/[^/]+\/(returns|compare|changes))\/?$/i;
const isHeavy = path => HEAVY.test(path);
const isApi = path => /^\/api\//i.test(path);

function positive(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// The time API requests spent in this process over a sliding window.
function busyMeter({ windowMs = 10000, now = () => Date.now() } = {}) {
  const spans = []; // [endedAt, ms]
  const prune = t => {
    while (spans.length && spans[0][0] <= t - windowMs) spans.shift();
  };
  return {
    record(ms, at = now()) {
      spans.push([at, ms]);
      prune(at);
    },
    used(at = now()) {
      prune(at);
      return spans.reduce((t, [, ms]) => t + ms, 0);
    },
    windowMs,
  };
}

// The time each visitor's API requests used over a sliding window (a minute).
// At most maxVisitors are kept: past it, visitors with nothing left in the
// window go first, then the least recently seen.
function visitorMeter({ windowMs = 60000, now = () => Date.now(), maxVisitors = 10000 } = {}) {
  const byVisitor = new Map(); // key -> [[endedAt, ms], ...], least recently seen first
  const prune = (spans, t) => {
    while (spans.length && spans[0][0] <= t - windowMs) spans.shift();
  };
  const trim = t => {
    if (byVisitor.size <= maxVisitors) return;
    for (const [k, spans] of byVisitor) {
      prune(spans, t);
      if (!spans.length) byVisitor.delete(k);
    }
    for (const k of byVisitor.keys()) {
      if (byVisitor.size <= maxVisitors) break;
      byVisitor.delete(k);
    }
  };
  return {
    record(key, ms, at = now()) {
      const spans = byVisitor.get(key) || [];
      byVisitor.delete(key); // most recently seen goes last
      spans.push([at, ms]);
      prune(spans, at);
      byVisitor.set(key, spans);
      trim(at);
    },
    used(key, at = now()) {
      const spans = byVisitor.get(key);
      if (!spans) return 0;
      prune(spans, at);
      return spans.reduce((t, [, ms]) => t + ms, 0);
    },
    // Seconds until the visitor's use falls back under `limit`.
    retryAfter(key, limit, at = now()) {
      const spans = byVisitor.get(key) || [];
      let used = spans.reduce((t, [, ms]) => t + ms, 0);
      for (const [endedAt, ms] of spans) {
        used -= ms;
        if (used < limit) return Math.max(1, Math.ceil((endedAt + windowMs - at) / 1000));
      }
      return 1;
    },
    size: () => byVisitor.size,
    windowMs,
  };
}

// A visitor: the address the request came from (behind the trusted proxy, the
// forwarded one), IPv6 grouped by /56 as express-rate-limit does.
const visitorOf = req => ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown', 56);

function heavyGuard({
  perMinute = positive(process.env.HEAVY_RATE_LIMIT_PER_MIN, 90),
  busyShare = positive(process.env.HEAVY_BUSY_SHARE, 0.6),
  visitorMsPerMin = positive(process.env.VISITOR_MS_PER_MIN, 15000),
  busyVisitorMs = positive(process.env.BUSY_VISITOR_MS, 2000),
  meter = busyMeter(),
  visitors = visitorMeter(),
  clock = () => performance.now(),
} = {}) {
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: perMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many detailed queries from this address. Wait a minute and try again.' },
  });
  // Charges the request's time to the process and to its visitor, once, when
  // the response ends (or the client goes away).
  const charge = (req, res, key) => {
    const started = clock();
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      const ms = clock() - started;
      meter.record(ms);
      visitors.record(key, ms);
    };
    res.once('finish', end);
    res.once('close', end);
  };
  return (req, res, next) => {
    if (!isApi(req.path)) return next();
    const key = visitorOf(req);
    if (visitors.used(key) >= visitorMsPerMin) {
      return res
        .status(429)
        .set({ 'Retry-After': String(visitors.retryAfter(key, visitorMsPerMin)), 'Cache-Control': 'no-store' })
        .json({ error: 'This address has used its share of the server for this minute. Try again shortly.' });
    }
    if (!isHeavy(req.path)) {
      charge(req, res, key);
      return next();
    }
    return limiter(req, res, () => {
      if (meter.used() > meter.windowMs * busyShare && visitors.used(key) > busyVisitorMs) {
        return res
          .status(503)
          .set({ 'Retry-After': '5', 'Cache-Control': 'no-store' })
          .json({ error: 'The server is busy with other detailed queries. Try again in a few seconds.' });
      }
      charge(req, res, key);
      return next();
    });
  };
}

module.exports = { heavyGuard, busyMeter, visitorMeter, isHeavy, isApi, visitorOf, HEAVY };
