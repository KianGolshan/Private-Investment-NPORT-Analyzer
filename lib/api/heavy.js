// Guards for the expensive warehouse routes (2026-10-13 review, F-05). The
// warehouse is read through better-sqlite3, which is synchronous: an uncached
// pivot over every month, a firm's full change history or a company's stored
// rows holds the process for 1-1.5 s, and nothing else is answered meanwhile.
// Two limits keep one visitor's script from slowing the site for everyone:
//
//   1. a per-visitor rate for heavy routes (HEAVY_RATE_LIMIT_PER_MIN, 90), well
//      above what clicking through pages needs (a page makes 1-4 such calls);
//   2. a per-process budget: when heavy requests have used more than
//      HEAVY_BUSY_SHARE (0.6) of the last 10 s, new ones answer 503 "busy" with
//      Retry-After, so light requests (search, company headers, health) still
//      get through. Answers the memo already holds cost ~nothing, and are
//      counted by their real time, so a warm site never trips it.
const rateLimit = require('express-rate-limit');

// The routes whose uncached answer can take over ~200 ms on the full warehouse.
const HEAVY =
  /^\/api\/(analysis\/[^/]+|feed|market\/(movers|new)|firms\/[^/]+\/changes|companies\/[^/]+\/(rows|activity|legs|bridge|trend)|entities\/[^/]+\/(rows|activity|legs|bridge|trend)|funds\/[^/]+\/(returns|compare|changes))\/?$/;
const isHeavy = path => HEAVY.test(path);

function positive(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// The time heavy requests spent in this process over a sliding window.
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

function heavyGuard({
  perMinute = positive(process.env.HEAVY_RATE_LIMIT_PER_MIN, 90),
  busyShare = positive(process.env.HEAVY_BUSY_SHARE, 0.6),
  meter = busyMeter(),
  clock = () => performance.now(),
} = {}) {
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: perMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many detailed queries from this address. Wait a minute and try again.' },
  });
  return (req, res, next) => {
    if (!isHeavy(req.path)) return next();
    limiter(req, res, () => {
      if (meter.used() > meter.windowMs * busyShare) {
        return res
          .status(503)
          .set({ 'Retry-After': '5', 'Cache-Control': 'no-store' })
          .json({ error: 'The server is busy with other detailed queries. Try again in a few seconds.' });
      }
      const started = clock();
      res.on('finish', () => meter.record(clock() - started));
      next();
    });
  };
}

module.exports = { heavyGuard, busyMeter, isHeavy, HEAVY };
