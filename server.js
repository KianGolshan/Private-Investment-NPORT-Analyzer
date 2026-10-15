require('dotenv').config();
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { openWarehouseReadOnly } = require('./lib/warehouse/db');
const { warehouseRouter } = require('./lib/api/warehouse');
const { adminRouter, adminEnabled, isLocalRequest } = require('./lib/api/admin');
const { heavyGuard } = require('./lib/api/heavy');
const pages = require('./lib/api/pages');

const app = express();
// The frontend is served from this same Express instance and never calls
// /api/* cross-origin, so no CORS grant is needed at all.
// Security headers. The analyst workspace (web/dist) loads only its own
// module scripts, so its policy allows scripts from this server alone (staff
// review F01: no inline script can run even if markup slipped through).
// connect-src 'self' keeps page JS from sending data anywhere but this API.
const cspOf = scripts =>
  [
    "default-src 'self'",
    `script-src ${scripts}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
// Cloudflare Web Analytics (P9, optional, cookieless): its beacon script and
// endpoint are allowed only when VANTAGE_ANALYTICS_TOKEN is set.
const ANALYTICS = pages.analyticsToken(process.env.VANTAGE_ANALYTICS_TOKEN);
const CSP = ANALYTICS
  ? cspOf("'self' https://static.cloudflareinsights.com").replace(
      "connect-src 'self'",
      "connect-src 'self' https://cloudflareinsights.com"
    )
  : cspOf("'self'");
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // no camera, microphone, location or the like for any page or embed
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
});
// The analyst workspace (web/, built into web/dist) is the app. v1 (the tabbed
// page, Private Credit and the live per-filing routes) was removed from the
// live project; it is kept, runnable, at the git tag v1-archive.
const WEB_DIST = path.join(__dirname, 'web', 'dist');
const WEB_INDEX = path.join(WEB_DIST, 'index.html');
const webBuilt = () => require('fs').existsSync(WEB_INDEX);
const APP_ROUTES = [
  '/',
  '/company/:ref',
  '/name/:key',
  '/fund/:key',
  '/firm/:id',
  '/firms',
  '/activity',
  '/explore',
  '/tracked',
  '/compare',
  '/about',
  '/status',
];
// The site's own address for canonical and Open Graph URLs: VANTAGE_PUBLIC_URL,
// else what the request came in on (behind the trusted proxy, its scheme).
const originOf = req => (process.env.VANTAGE_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const readIndex = pages.indexReader(WEB_INDEX);
// A workspace page: index.html with this page's head (lib/api/pages.js). A
// company, fund or firm that does not exist answers 404 (the app shows its own
// not-found view); so does any other unknown page (the fallback at the end).
function sendPage(req, res, { status = 200 } = {}) {
  const fixed = pages.STATIC_PAGES[req.path];
  const meta = status === 200 && !fixed ? warehouseApi.pageMeta(req.path) : null;
  const notFound = status === 404 || !!meta?.notFound;
  const head = pages.headTags({
    title: notFound ? 'Not found' : (fixed?.title ?? meta?.title ?? pages.DEFAULT_TITLE),
    description: fixed?.description ?? meta?.description ?? pages.DEFAULT_DESCRIPTION,
    origin: originOf(req),
    path: req.path,
    // unknown pages, and unreviewed names (tens of thousands of raw filer labels)
    noindex: notFound || req.path.startsWith('/name/'),
    analytics: ANALYTICS,
  });
  res
    .status(notFound ? 404 : 200)
    .set('Cache-Control', 'no-cache')
    .type('html')
    .send(pages.renderIndex(readIndex(), head));
}
const NOT_BUILT = 'The workspace is not built yet: run npm run build:web, then reload.';
app.get(APP_ROUTES, (req, res) =>
  webBuilt() ? sendPage(req, res) : res.status(503).set('Cache-Control', 'no-store').type('text').send(NOT_BUILT)
);
app.get('/robots.txt', (req, res) =>
  res
    .type('text/plain')
    .set('Cache-Control', 'public, max-age=3600')
    .send(pages.robotsTxt(originOf(req)))
);
app.get('/sitemap.xml', (req, res) =>
  res
    .type('application/xml')
    .set('Cache-Control', 'public, max-age=3600')
    .send(pages.sitemapXml(originOf(req), warehouseApi.sitemapEntries()))
);
app.use('/assets', express.static(path.join(WEB_DIST, 'assets'), { immutable: true, maxAge: '1y', index: false }));
// public/ beside this file, whatever the working directory (the e2e server runs from web/)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const USER_AGENT = process.env.SEC_USER_AGENT || '';
const EFFECTIVE_USER_AGENT = USER_AGENT || 'Vantage internal-tool@localhost';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
// The public site (P9): every page answers from the warehouse, so no visitor
// causes an SEC request; only the nightly job calls the SEC. Public mode turns
// off the admin actions and labels the site as public in /api/config.
const PUBLIC_MODE = process.env.VANTAGE_PUBLIC === '1';
// The code version: the ETag on warehouse answers and what open tabs compare
// to offer a reload after a deploy. Every instance of one deploy must agree,
// so the deploy sets APP_BUILD (the commit); else this process's start.
const BUILD = process.env.APP_BUILD || Date.now().toString(36);

// Where the server listens (staff full-stack review R11): loopback unless HOST
// says otherwise, so the origin is reachable only through a proxy on this host.
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'].includes(HOST);
// X-Forwarded-For is trusted only where a client cannot set it itself: a proxy
// in front of a loopback-only origin. Behind a proxy, express-rate-limit's
// per-IP buckets need the forwarded address (else every visitor shares the
// proxy's one budget); without one, trusting the header lets a client spoof
// req.ip. TRUST_PROXY=<hops> declares the topology explicitly (0 = never). In
// production with no TRUST_PROXY: 1 hop on a loopback origin, none on a public
// one (with a warning at start-up). Development never trusts it.
const TRUST_PROXY = (() => {
  const raw = process.env.TRUST_PROXY;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`TRUST_PROXY must be a hop count (0, 1, 2, ...), got "${raw}"`);
    return n;
  }
  return IS_PRODUCTION && LOOPBACK ? 1 : 0;
})();
if (TRUST_PROXY) app.set('trust proxy', TRUST_PROXY);

if (!USER_AGENT) {
  console.warn('\n⚠️  WARNING: SEC_USER_AGENT not set.');
  console.warn('   Copy .env.example to .env and add your name and email.');
  console.warn('   The SEC requires this header for EDGAR API access.\n');

  // In production this app's own outbound requests to SEC (not just this
  // one user's) all share EFFECTIVE_USER_AGENT — running a public instance
  // with the generic fallback risks SEC rate-limiting/blocking that IP for
  // everyone using it. Local/dev usage is unaffected: it still just warns
  // and runs, same as before.
  if (IS_PRODUCTION) {
    console.error('❌ Refusing to start in production without a real SEC_USER_AGENT.');
    console.error('   Set SEC_USER_AGENT in the environment before deploying.\n');
    process.exit(1);
  }
}

// Health (P9), before the rate limits: a balancer and an uptime monitor poll
// these. /healthz: the process answers. /readyz: 200 once this process serves a
// warmed warehouse, else 503; ?fresh=1 also needs a refresh within
// VANTAGE_READY_MAX_AGE_HOURS (48) and a last job that did not fail; ?report=1
// answers 200 with the same body (the status page).
// /healthz also reports this process's memory and how long a request waited
// behind synchronous work over the last minute (review R17; scripts/loadtest.js).
const loopDelay = require('perf_hooks').monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
setInterval(() => loopDelay.reset(), 60000).unref();
app.get('/healthz', (_req, res) =>
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    build: BUILD,
    uptimeS: Math.round(process.uptime()),
    rssMB: Math.round(process.memoryUsage.rss() / 1048576),
    loopP99Ms: Math.round(loopDelay.percentile(99) / 1e6),
    loopMaxMs: Math.round(loopDelay.max / 1e6),
  })
);
app.get('/readyz', (req, res) => {
  const maxAgeHours = Number(process.env.VANTAGE_READY_MAX_AGE_HOURS) || 48;
  const r = warehouseApi.readiness({ maxAgeHours });
  const strict = req.query.fresh === '1' || req.query.fresh === 'true';
  // ?report=1: always 200 with the same body, for a page that shows it (/status)
  const report = req.query.report === '1';
  res
    .status(report || (strict ? r.fresh : r.ready) ? 200 : 503)
    .set('Cache-Control', 'no-store')
    .json({ ...r, build: BUILD });
});

// A per-visitor ceiling on every API route: far above a person clicking through
// pages, low enough to bound a scripted flood. The heavy routes have their own,
// smaller budget below.
const parsedApiLimit = Number(process.env.API_RATE_LIMIT_PER_MIN);
const API_RATE_LIMIT_PER_MIN = Number.isFinite(parsedApiLimit) && parsedApiLimit > 0 ? parsedApiLimit : 1500;
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: API_RATE_LIMIT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down and try again shortly.' },
});
app.use('/api/', apiLimiter);
// The expensive warehouse routes get their own, smaller budget and shed load
// when heavy work fills the process (lib/api/heavy.js, review F-05).
app.use(heavyGuard());

// Warehouse routes (Phase 5a, ADR 0008): search, companies and unreviewed
// names, answered from warehouse.db opened read-only on first use (missing or
// behind: those routes answer 503). They never call the SEC.
const warehouseApi = warehouseRouter(() => openWarehouseReadOnly(), { warmOnSwitch: true, build: BUILD });
app.use('/api', warehouseApi);
app.locals.warehouseApi = warehouseApi; // scripts/bench.js warms it as start-up does
// Admin actions ("make this a company"): local, admin-only, run as a job
// (lib/api/admin.js); refused unless VANTAGE_ADMIN=1 and the request is local.
app.use('/api/admin', adminRouter());

app.get('/api/config', (req, res) => {
  // admin: the "make this a company" action is available to this viewer (lib/api/admin.js).
  res.set('Cache-Control', 'no-store').json({
    userAgentConfigured: !!USER_AGENT,
    admin: adminEnabled() && isLocalRequest(req),
    public: PUBLIC_MODE,
    build: BUILD,
    // the uptime monitor's public page, linked from /status (P9)
    statusUrl: /^https:\/\/[^\s"'<>]+$/.test(process.env.VANTAGE_STATUS_URL || '')
      ? process.env.VANTAGE_STATUS_URL
      : null,
  });
});

// Any other page a browser asks for: the workspace's not-found view, as a 404
// (a crawler then drops the URL). API paths and files keep their plain 404.
app.use((req, res, next) => {
  const file = /\.[a-z0-9]+$/i.test(req.path); // a missing asset or file stays a plain 404
  if (req.method !== 'GET' || req.path.startsWith('/api/') || file || !webBuilt() || !req.accepts('html'))
    return next();
  return sendPage(req, res, { status: 404 });
});

// Only actually bind a port when this file is run directly (`node server.js`
// / `npm start`) — not when required by a test, so integration tests can
// drive `app` in-process via supertest without opening a real socket.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, HOST, () => {
    console.log(`\n✅ Vantage running at http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`);
    if (IS_PRODUCTION && !LOOPBACK && process.env.TRUST_PROXY === undefined)
      console.warn(
        `   Listening on ${HOST} with no TRUST_PROXY: X-Forwarded-For is ignored, so behind a proxy every visitor ` +
          'shares one rate-limit bucket. Set TRUST_PROXY to the number of proxies in front, only if clients cannot ' +
          'reach this port directly.'
      );
    console.log(`   User-Agent: ${EFFECTIVE_USER_AGENT}\n`);
    // A generation published by the nightly job is switched to without waiting
    // for a visitor (warm first, then swap; lib/api/warehouse.js).
    setInterval(() => warehouseApi.checkSwitch(), 15000).unref();
    warehouseApi.warm().then(w => {
      console.log(
        w.error ? `   Warehouse: ${w.error}` : `   Warehouse warmed: ${w.companies} tracked companies in ${w.ms} ms`
      );
    });
  });
}

module.exports = app;
