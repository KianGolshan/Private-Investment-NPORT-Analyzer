require('dotenv').config();
const path = require('path');
const express = require('express');
const xml2js = require('xml2js');
const cheerio = require('cheerio');
const rateLimit = require('express-rate-limit');
const cache = require('./cache');
const { fetchWithRetry } = require('./lib/edgar');
const { openWarehouseReadOnly } = require('./lib/warehouse/db');
const { warehouseRouter } = require('./lib/api/warehouse');
const { adminRouter, adminEnabled, isLocalRequest } = require('./lib/api/admin');
const {
  extractHoldings,
  extractCreditHoldings,
  extractFundMeta,
  extractAllHoldings,
  buildFundXRay,
  buildFundXRayComparison,
  buildPositionReturns,
} = require('./parsers');

const app = express();
// The frontend is served from this same Express instance (express.static
// below) and never needs to call /api/* cross-origin — so no CORS grant is
// needed at all. Without this, cors() with no options reflects any Origin
// header back with credentials-less wildcard access, letting any external
// website's JS call these SEC-proxying endpoints on a visitor's behalf.
// Security headers. script-src must allow 'unsafe-inline' because the UI wires
// its buttons with inline onclick attributes, but it still pins every script
// ORIGIN to this server plus the two SRI-pinned CDNs in index.html, and
// connect-src 'self' keeps page JS from sending data anywhere but this API.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.sheetjs.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});
// lib/analytics/peer.js is shared with the browser, like public/splits.js (P5b).
app.get('/peer.js', (_req, res) => res.sendFile(path.join(__dirname, 'lib', 'analytics', 'peer.js')));
app.use(express.static('public'));
// Permalinks (ADR 0008): the page itself; app.js reads the path.
app.get(['/company/:ref', '/name/:key', '/fund/:key', '/firm/:id'], (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

const USER_AGENT = process.env.SEC_USER_AGENT || '';
const EFFECTIVE_USER_AGENT = USER_AGENT || 'Vantage internal-tool@localhost';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Only trust X-Forwarded-For in production, where a public deployment is
// expected to sit behind a reverse proxy/load balancer — otherwise
// express-rate-limit's per-IP bucketing keys off req.ip, which resolves to
// the proxy's own address for every visitor when trust proxy is unset,
// collapsing the 200 req/min cap below into one shared budget for every
// user instead of one per visitor. Left off in local/dev, where there's no
// proxy and trusting a client-supplied header would let it spoof req.ip.
if (IS_PRODUCTION) app.set('trust proxy', 1);

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

// Rate limiting on the SEC-hitting API routes — not to throttle a normal
// single-user session (batch/watchlist runs can legitimately fire well over
// a hundred requests in a burst), but to bound a scripted flood hitting this
// server directly and either exhausting it or getting our shared
// SEC_USER_AGENT blocked by SEC for every user of a public deployment.
// Outbound SEC traffic is paced separately (see pace() below), so this cap only
// has to stop a scripted flood — but it must not trip a legitimate large run:
// with a warm cache the client fires ~20 requests/second (5 per 250ms), so a
// 10-issuer Watchlist run at 100 filings each is ~1,000 requests, which the old
// 200/min cap turned into "Too many requests" errors partway through.
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

// `refresh` skips the cache and forces fresh SEC fetches, so it is the one
// knob a visitor could use to push this server's (shared) SEC traffic around.
// Only an explicit refresh=1/true counts — any value used to, including
// refresh=0 — and forced refreshes get their own, much smaller budget.
function wantsRefresh(req) {
  const v = String(req.query.refresh ?? '').toLowerCase();
  return v === '1' || v === 'true';
}
const parsedRefreshLimit = Number(process.env.REFRESH_RATE_LIMIT_PER_MIN);
const REFRESH_RATE_LIMIT_PER_MIN =
  Number.isFinite(parsedRefreshLimit) && parsedRefreshLimit > 0 ? parsedRefreshLimit : 30;
app.use(
  '/api/',
  rateLimit({
    windowMs: 60 * 1000,
    max: REFRESH_RATE_LIMIT_PER_MIN,
    skip: req => !wantsRefresh(req),
    standardHeaders: false,
    legacyHeaders: false,
    message: { error: 'Too many forced refreshes — cached results are still available without refresh.' },
  })
);

// Warehouse routes (Phase 5a, ADR 0008): search, companies and unreviewed
// names, answered from warehouse.db opened read-only on first use (missing or
// behind: those routes answer 503, the live routes below keep working). They
// never call the SEC.
const warehouseApi = warehouseRouter(() => openWarehouseReadOnly());
app.use('/api', warehouseApi);
// Admin actions ("make this a company"): local, admin-only, run as a job
// (lib/api/admin.js); refused unless VANTAGE_ADMIN=1 and the request is local.
app.use('/api/admin', adminRouter());

// EDGAR identifiers go straight into sec.gov archive URLs, so they are
// validated, not just URL-encoded: a CIK is up to 10 digits, an accession
// number 18 digits once its dashes are stripped. Both return null if invalid.
function normalizeCik(raw) {
  const cik = String(raw ?? '')
    .trim()
    .replace(/^0+(?=\d)/, '');
  return /^\d{1,10}$/.test(cik) ? cik : null;
}
function normalizeAccession(raw) {
  const acc = String(raw ?? '')
    .trim()
    .replace(/-/g, '');
  return /^\d{18}$/.test(acc) ? acc : null;
}

// Error text safe to show a visitor: our own thrown messages pass through,
// but upstream HTTP-client errors (which can carry internal detail such as
// mock/request dumps or socket errors) are reduced to status/timeout.
function publicError(err) {
  if (err?.isAxiosError || err?.response || err?.config) {
    if (err.response?.status) return `SEC request failed (HTTP ${err.response.status})`;
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return 'SEC request timed out';
    return 'SEC request failed';
  }
  return err?.message || 'Unknown error';
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Outbound SEC requests are paced process-wide and retried on throttling;
// see lib/edgar.js (shared with the warehouse jobs).

// Fetch a filer's complete filing history from the EDGAR submissions API,
// flattening the paginated "files" (older filings) alongside "recent".
// Returns both the registrant's name and its full filing history — the
// name is read off the same first response that "recent" comes from, so
// exposing it here costs nothing extra and lets callers avoid a second,
// redundant fetch just to learn who the filer is (see fetchFundNportHistory).
async function fetchSubmissionsAllPages(cikPadded) {
  const entries = [];
  const pushEntries = block => {
    const forms = block.form || [];
    const accs = block.accessionNumber || [];
    const fileDates = block.filingDate || [];
    const periods = block.reportDate || [];
    const primaryDocs = block.primaryDocument || [];
    for (let i = 0; i < accs.length; i++) {
      entries.push({
        form: forms[i],
        accessionNumber: accs[i],
        filingDate: fileDates[i],
        reportDate: periods[i],
        primaryDocument: primaryDocs[i],
      });
    }
  };

  const subUrl = `https://data.sec.gov/submissions/CIK${encodeURIComponent(cikPadded)}.json`;
  const subResp = await fetchWithRetry({
    url: subUrl,
    method: 'get',
    headers: { 'User-Agent': EFFECTIVE_USER_AGENT, Accept: 'application/json' },
    timeout: 15000,
  });
  pushEntries(subResp.data.filings?.recent || {});

  const files = subResp.data.filings?.files || [];
  for (const file of files) {
    try {
      const pageResp = await fetchWithRetry({
        url: `https://data.sec.gov/submissions/${file.name}`,
        method: 'get',
        headers: { 'User-Agent': EFFECTIVE_USER_AGENT, Accept: 'application/json' },
        timeout: 10000,
      });
      pushEntries(pageResp.data);
    } catch (e) {
      console.error(`Submissions page error (${file.name}):`, e.message);
    }
  }
  return { name: subResp.data.name || '', entries };
}

// Strip trailing ticker/CIK parentheticals from EFTS display names,
// e.g. "FS KKR Capital Corp (FSK)" -> "FS KKR Capital Corp".
function cleanFilerName(raw) {
  const name = String(raw || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
  return name || String(raw || 'Unknown');
}

// EDGAR full-text search (EFTS) returns at most 100 hits per request whatever
// `size` asks for — reading only the first page silently dropped most matches
// on popular names (real counts: Anthropic 837 NPORT-P filings, Pluralsight
// 353 10-Qs). Pages through with `from`, up to EFTS_MAX_HITS. Returns the
// first page's body with hits.hits replaced by one hit per filing.
//
// EFTS returns one hit per matching *document*, so a single filing can come
// back several times (real: 412 of the 100-most-recent slots across 20
// private companies were repeats of an accession already listed). Hits are
// therefore de-duplicated by accession (`_source.adsh`), falling back to
// `_id`. hits.total is EDGAR's document count; when every page was read it
// is replaced by the unique filing count, so "N matching filings" is true.
//
// EFTS ranks hits by relevance, not date. When a name has more than
// EFTS_MAX_HITS matching documents, reading the first EFTS_MAX_HITS returned
// an arbitrary slice of years, and "the N most recent" was only the most
// recent *within that slice* (real: "Epic Games" skipped three Fidelity
// filings from 2026-05-26 while its "100 most recent" reached back to
// 2026-01-23). Over the cap, the search instead walks date windows
// (startdt/enddt) newest-first, splitting any window that is itself over the
// cap, until EFTS_MAX_HITS documents are read or every match has been seen.
const EFTS_PAGE_SIZE = 100;
const parsedEftsMax = Number(process.env.EFTS_MAX_HITS);
const EFTS_MAX_HITS = Number.isFinite(parsedEftsMax) && parsedEftsMax > 0 ? parsedEftsMax : 1000;
const EFTS_WINDOW_DAYS = 92;
const EFTS_EARLIEST = new Date('2001-01-01T00:00:00Z'); // start of EDGAR full-text coverage
const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = d => d.toISOString().slice(0, 10);

async function eftsPage(params, from) {
  const resp = await fetchWithRetry({
    url: 'https://efts.sec.gov/LATEST/search-index',
    method: 'get',
    params: { ...params, from, size: EFTS_PAGE_SIZE },
    headers: { 'User-Agent': EFFECTIVE_USER_AGENT, Accept: 'application/json' },
    timeout: 30000,
  });
  return resp.data || {};
}

function eftsOverCap(body) {
  const total = body?.hits?.total;
  return total?.relation === 'gte' || Number(total?.value) > EFTS_MAX_HITS;
}

// The document a hit matched is the part of its `_id` after the accession
// ("0001193125-26-323081:primary_doc.xml"). Empty when EFTS gives no name.
const eftsHitDocument = hit => String(hit._id || '').split(':')[1] || '';

// `onlyDocument` keeps only hits that matched in that document. For NPORT-P
// it is 'primary_doc.xml', the structured holdings list: a trust's shared
// schedule-of-investments attachment names every sibling fund's holdings, so
// a match only there has no holding row in this filing (real, filings made
// 2026-07-01..09-27: 328 of 328 filings with a row had a primary_doc.xml hit,
// 0 of 208 attachment-only filings did, across Anthropic/Databricks/Stripe).
// Hits without a document name are kept.
async function fetchEftsAllHits(params, { onlyDocument } = {}) {
  const hits = [];
  const seen = new Set();
  let docsRead = 0;
  const add = page => {
    docsRead += page.length;
    for (const hit of page) {
      const doc = eftsHitDocument(hit);
      if (onlyDocument && doc && !doc.endsWith(onlyDocument)) continue;
      const id = hit._source?.adsh || hit._id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      hits.push(hit);
    }
  };
  // Reads every page of one query (at most EFTS_MAX_HITS documents),
  // starting from an already-fetched first page. True if all were read.
  const drain = async (queryParams, firstBody) => {
    let body = firstBody;
    for (let from = 0; ;) {
      const page = body?.hits?.hits || [];
      add(page);
      const total = Number(body?.hits?.total?.value);
      from += EFTS_PAGE_SIZE;
      if (page.length < EFTS_PAGE_SIZE || (Number.isFinite(total) && from >= total)) return true;
      if (from >= EFTS_MAX_HITS) return false;
      body = await eftsPage(queryParams, from);
    }
  };

  const first = await eftsPage(params, 0);
  const firstHits = first.hits || {};

  if (!eftsOverCap(first)) {
    const complete = await drain(params, first);
    const total =
      complete && firstHits.total ? { ...firstHits.total, value: hits.length, relation: 'eq' } : firstHits.total;
    return { ...first, hits: { ...firstHits, ...(total ? { total } : {}), hits } };
  }

  // Over the cap: newest-first date windows.
  const totalDocs = firstHits.total?.relation === 'eq' ? Number(firstHits.total.value) : Infinity;
  let end = new Date(Date.now());
  let span = EFTS_WINDOW_DAYS;
  while (docsRead < EFTS_MAX_HITS && docsRead < totalDocs && end >= EFTS_EARLIEST) {
    const start = new Date(Math.max(EFTS_EARLIEST.getTime(), end.getTime() - (span - 1) * DAY_MS));
    const windowParams = { ...params, startdt: isoDay(start), enddt: isoDay(end) };
    const body = await eftsPage(windowParams, 0);
    if (eftsOverCap(body) && span > 1) {
      span = Math.max(1, Math.floor(span / 2));
      continue;
    }
    await drain(windowParams, body);
    end = new Date(start.getTime() - DAY_MS);
    span = EFTS_WINDOW_DAYS;
  }
  return { ...first, hits: { ...firstHits, hits }, newestFirst: true };
}

// EFTS treats an unquoted multi-word query as separate words matched anywhere
// in a filing (real: "Redwood Materials" → 10,000+ hits unquoted vs. 2,469
// quoted), so multi-word names are sent as an exact phrase. Single words and
// queries the user already quoted pass through unchanged.
function eftsPhrase(term) {
  const t = String(term).trim();
  if (!/\s/.test(t) || /^".*"$/.test(t)) return t;
  return `"${t.replace(/"/g, '')}"`;
}

// Config endpoint — lets the frontend show a warning if user-agent isn't set
app.get('/api/config', (req, res) => {
  // admin: the "make this a company" action is available to this viewer (lib/api/admin.js).
  res.json({ userAgentConfigured: !!USER_AGENT, admin: adminEnabled() && isLocalRequest(req) });
});

// Search for NPORT-P filings matching a security name/ticker
// ── v1 per-filing routes: a compatibility layer (ROADMAP §5b task 7, ADR 0008) ──
// Since P5b the app answers private companies and funds from the warehouse
// (/api/search, /api/companies, /api/entities, /api/funds). It calls the routes
// below only for the live path: listed companies, debt, names the warehouse
// cannot match, and when the warehouse is unavailable (labeled "live, not
// warehoused"). They stay for that and for existing links and scripts
// (test/app-retired.test.js pins which views may still reach them).
app.get('/api/search-nport', async (req, res) => {
  const { security } = req.query;
  if (!security) return res.status(400).json({ error: 'security parameter required' });

  // v2: now every page of EFTS hits, not just the first 100.
  // v3: one hit per filing (deduped by accession), multi-word names quoted,
  //     newest-first date windows over the hit cap, primary_doc.xml matches only.
  const cacheKey = cache.searchKey('search:nport:v3', security);
  if (!wantsRefresh(req)) {
    const cached = cache.getSearch(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });
  }

  try {
    const data = await cache.withInFlight(cacheKey, async () => {
      const body = await fetchEftsAllHits(
        { q: eftsPhrase(security), category: 'form-cat1', forms: 'NPORT-P' },
        { onlyDocument: 'primary_doc.xml' }
      );
      cache.setSearch(cacheKey, body);
      return body;
    });
    res.json({ ...data, cached: false });
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: publicError(error) });
  }
});

// Fetch and parse a single NPORT-P XML filing, returning matching holdings
app.get('/api/parse-nport', async (req, res) => {
  const { security } = req.query;
  // Normalized once, up front — the SEC URL below needs the dash-stripped
  // form anyway, and building the cache key from the raw (dashed) query
  // param instead let the same filing requested with vs. without dashes
  // produce two different cache keys and two redundant SEC fetches.
  const cik = normalizeCik(req.query.cik);
  const accession = normalizeAccession(req.query.accession);
  if (!req.query.cik || !req.query.accession || !security) {
    return res.status(400).json({ error: 'cik, accession, and security are required' });
  }
  if (!cik || !accession) {
    return res.status(400).json({ error: 'cik must be up to 10 digits and accession 18 digits (dashes allowed)' });
  }

  // A given (cik, accession, security) is a specific historical filing's
  // content — it never changes, so this is cached indefinitely (no TTL).
  const cacheKey = cache.holdingsKey('holdings:nport', cik, accession, security);
  if (!wantsRefresh(req)) {
    const cached = cache.getHoldings(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        holdings: cached,
        message: cached.length > 0 ? 'Found holdings' : 'No matching holdings',
        cached: true,
      });
    }
  }

  try {
    const holdings = await cache.withInFlight(cacheKey, async () => {
      await delay(50);

      const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${encodeURIComponent(cik)}/${encodeURIComponent(accession)}/primary_doc.xml`;
      const xmlResponse = await fetchWithRetry({
        url: xmlUrl,
        method: 'get',
        headers: { 'User-Agent': EFFECTIVE_USER_AGENT },
        timeout: 30000,
      });

      const parser = new xml2js.Parser({
        explicitArray: false,
        mergeAttrs: true,
        normalizeTags: true,
        tagNameProcessors: [xml2js.processors.stripPrefix],
      });

      const result = await parser.parseStringPromise(xmlResponse.data);
      const parsed = extractHoldings(result, security);
      cache.setHoldings(cacheKey, parsed);
      return parsed;
    });

    res.json({
      success: true,
      holdings,
      message: holdings.length > 0 ? 'Found holdings' : 'No matching holdings',
      cached: false,
    });
  } catch (error) {
    res.json({ success: false, holdings: [], error: publicError(error) });
  }
});

// ── Private Credit: Search BDC 10-Q / 10-K filings ────────────────────────
// A BDC's schedule of investments appears in every 10-Q and in its 10-K; the
// 10-K is the only one covering the fiscal year-end, so 10-Q alone left a
// hole every fourth quarter. The same table parser reads both (checked on
// real 10-Ks from OCSL, Oaktree Gardens, KKR FS Income Trust, Apollo Debt
// Solutions, Onex, AGL).
const CREDIT_FORMS = ['10-Q', '10-K'];
// BDC identification strategy: SEC EDGAR assigns Investment Company Act file
// numbers starting with "814-" to Business Development Companies. This is
// present on every EFTS search hit and is authoritative — no hard-coded CIK
// lists needed. We first pull EFTS full-text-search hits that actually
// mention the issuer (confirmed), then fetch each identified BDC's complete
// 10-Q filing history via the submissions API to close gaps where EFTS may
// not surface every quarter for older filings.
app.get('/api/search-10q', async (req, res) => {
  const { issuer, maxPerFund } = req.query;
  if (!issuer) return res.status(400).json({ error: 'issuer parameter required' });
  // Number(maxPerFund) rather than `maxPerFund ? parseInt(...) : null` —
  // that ternary treated maxPerFund=0 (a deliberate "no historical filings"
  // request) and maxPerFund=abc (a bad param) identically to "not passed",
  // silently making the cap unlimited instead of 0 or a 400.
  const maxPerFundNum = maxPerFund != null && maxPerFund !== '' ? Number(maxPerFund) : null;
  if (maxPerFundNum != null && (!Number.isFinite(maxPerFundNum) || maxPerFundNum < 0)) {
    return res.status(400).json({ error: 'maxPerFund must be a non-negative number' });
  }

  // v2: 10-Ks included (the fiscal year-end schedule of investments — no 10-Q
  // covers Q4) and every page of EFTS hits read, not just the first 100.
  const cacheKey = cache.searchKey('search:10q:v2', issuer, maxPerFund || '');
  if (!wantsRefresh(req)) {
    const cached = cache.getSearch(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });
  }

  try {
    const result = await cache.withInFlight(cacheKey, async () => {
      const searchBody = await fetchEftsAllHits({ q: `"${issuer}"`, forms: CREDIT_FORMS.join(',') });
      const hits = searchBody?.hits?.hits || [];

      const confirmed = [];
      const bdcCikName = {}; // { "1422183": "FS KKR Capital Corp" }
      const confirmedAccessions = new Set();

      for (const hit of hits) {
        const src = hit._source || {};
        const fileNums = src.file_num || [];
        if (!fileNums.some(fn => String(fn).startsWith('814-'))) continue;

        const ciks = src.ciks || [];
        const cik = ciks[0] ? String(ciks[0]) : '';
        const cikStripped = cik.replace(/^0+/, '');
        const name = cleanFilerName(src.display_names?.[0]);
        if (cikStripped) bdcCikName[cikStripped] = name;

        const accession = src.adsh || '';
        confirmed.push({
          cik,
          accession,
          form: src.form || src.file_type || '',
          company: name,
          period: src.period_ending || src.file_date || '',
          fileDate: src.file_date || '',
          confirmed: true,
        });
        if (accession) confirmedAccessions.add(accession);
      }

      const historical = [];
      for (const [cikStripped, name] of Object.entries(bdcCikName)) {
        try {
          const cikPadded = cikStripped.padStart(10, '0');
          const { entries: allFilings } = await fetchSubmissionsAllPages(cikPadded);
          let count = 0;
          for (const f of allFilings) {
            if (!CREDIT_FORMS.includes(f.form)) continue;
            if (maxPerFundNum != null && count >= maxPerFundNum) break;
            const acc = f.accessionNumber || '';
            if (!acc || confirmedAccessions.has(acc)) {
              count++;
              continue;
            }
            historical.push({
              cik: cikStripped,
              accession: acc,
              form: f.form,
              company: name,
              period: f.reportDate || '',
              fileDate: f.filingDate || '',
              confirmed: false,
            });
            count++;
          }
          await delay(50);
        } catch (e) {
          console.error('Filing history error for', name, e.message);
        }
      }

      const byPeriod = f => f.period || f.fileDate || '';
      confirmed.sort((a, b) => byPeriod(b).localeCompare(byPeriod(a)));
      historical.sort((a, b) => byPeriod(b).localeCompare(byPeriod(a)));

      const payload = {
        filings: [...confirmed, ...historical],
        bdcFunds: [...new Set(Object.values(bdcCikName))].sort(),
        confirmed: confirmed.length,
        total: confirmed.length + historical.length,
      };
      cache.setSearch(cacheKey, payload);
      return payload;
    });
    res.json({ ...result, cached: false });
  } catch (error) {
    console.error('search-10q error:', error.message);
    res.status(500).json({ error: publicError(error) });
  }
});

// ── Private Credit: Parse a single 10-Q filing ────────────────────────────
app.get('/api/parse-10q', async (req, res) => {
  const { issuer, reportDate } = req.query;
  // Normalized once, up front — see the matching comment in /api/parse-nport.
  const cik = normalizeCik(req.query.cik);
  const accession = normalizeAccession(req.query.accession);
  if (!req.query.cik || !req.query.accession || !issuer) {
    return res.status(400).json({ error: 'cik, accession, and issuer are required' });
  }
  if (!cik || !accession) {
    return res.status(400).json({ error: 'cik must be up to 10 digits and accession 18 digits (dashes allowed)' });
  }

  // Same rationale as /api/parse-nport: a given (cik, accession, issuer,
  // reportDate) is a specific historical filing's content — immutable —
  // so it's cached indefinitely.
  const cacheKey = cache.holdingsKey('holdings:10q', cik, accession, issuer, reportDate || '');
  if (!wantsRefresh(req)) {
    const cached = cache.getHoldings(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        holdings: cached,
        message: cached.length > 0 ? 'Found holdings' : 'No matching holdings',
        cached: true,
      });
    }
  }

  try {
    const holdings = await cache.withInFlight(cacheKey, async () => {
      await delay(100);

      // Use the EDGAR submissions API to find the primary document
      const cikPadded = String(cik).replace(/^0+/, '').padStart(10, '0');
      let mainDocName = null;
      try {
        const { entries: allFilings } = await fetchSubmissionsAllPages(cikPadded);
        const match = allFilings.find(f => f.accessionNumber?.replace(/-/g, '') === accession);
        if (match?.primaryDocument) mainDocName = match.primaryDocument;
      } catch (e) {
        console.error('Submissions API error:', e.message);
      }

      if (!mainDocName) {
        throw new Error('Could not locate the filing’s main document via submissions API');
      }

      const docUrl = `https://www.sec.gov/Archives/edgar/data/${encodeURIComponent(cik)}/${encodeURIComponent(accession)}/${encodeURIComponent(mainDocName)}`;
      const htmlResp = await fetchWithRetry({
        url: docUrl,
        method: 'get',
        headers: { 'User-Agent': EFFECTIVE_USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
        // Real 10-Qs from large BDCs exceed the 25MB default (one Cloudera-holding
        // filing did), and take over a minute to arrive.
        timeout: 180000,
        maxContentLength: 100 * 1024 * 1024,
      });

      const $ = cheerio.load(htmlResp.data);
      const parsed = extractCreditHoldings($, issuer, reportDate || '');
      cache.setHoldings(cacheKey, parsed);
      return parsed;
    });

    res.json({
      success: true,
      holdings,
      message: holdings.length > 0 ? 'Found holdings' : 'No matching holdings',
      cached: false,
    });
  } catch (error) {
    console.error('10-Q parse error:', error.message);
    res.json({ success: false, holdings: [], error: publicError(error) });
  }
});

// ── Fund X-Ray: total private-market exposure in a fund's own NPORT-P ─────
// Distinct from /api/search-nport (which uses EDGAR full-text search to
// find OTHER funds mentioning a security in their own filing text — the
// right tool for that job). Full-text search is the WRONG tool here: it
// matches filing *content*, so searching for a fund by name mostly returns
// unrelated funds-of-funds that merely hold this fund as one of their own
// positions — real case found live: searching "SMALLCAP World Fund" this
// way returned 10,000+ hits, 97% of the first 100 from unrelated American
// Funds target-date series that just mention it, burying the actual
// SmallCap World Fund Inc filings. This instead resolves the fund/
// registrant's own CIK via EDGAR's company-name lookup, then pulls that
// CIK's own filing history — so its own filing can be found and pulled in
// full (not just ones matching a search term) for classification.

// EDGAR's company-name search (NOT full-text search) — matches the
// registrant itself. Returns candidate CIKs only: on an unambiguous name
// this feed's own <company-info><cik> is authoritative; on an ambiguous
// name (matches multiple registrants) SEC's atom output has a long-standing
// bug where each candidate's *name* is unserializable ("ARRAY(0x...)"), so
// only the CIK can be trusted here — the real name is recovered per-CIK via
// fetchFundNportHistory below.
//
// Returns { ciks, totalMatches }, not a bare array — capping at 5 candidates
// keeps a common family name (e.g. "Fidelity") from fanning out into dozens
// of downstream fetchFundNportHistory calls, but the caller still needs
// totalMatches to tell a user "only 5 of N shown," rather than silently
// implying only 5 registrants matched at all.
async function lookupFundCiks(fundName) {
  const response = await fetchWithRetry({
    url: 'https://www.sec.gov/cgi-bin/browse-edgar',
    method: 'get',
    params: {
      action: 'getcompany',
      company: fundName,
      type: 'NPORT-P',
      dateb: '',
      owner: 'include',
      count: 100,
      output: 'atom',
    },
    headers: { 'User-Agent': EFFECTIVE_USER_AGENT, Accept: 'application/xml' },
    timeout: 20000,
  });

  const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: false });
  const result = await parser.parseStringPromise(response.data);

  const singleCik = result?.feed?.['company-info']?.cik;
  if (singleCik) return { ciks: [String(singleCik).replace(/^0+/, '')], totalMatches: 1 };

  let entries = result?.feed?.entry;
  if (!entries) return { ciks: [], totalMatches: 0 };
  if (!Array.isArray(entries)) entries = [entries];
  const allCiks = [
    ...new Set(
      entries
        .map(e => e?.content?.['company-info']?.cik)
        .filter(Boolean)
        .map(c => String(c).replace(/^0+/, ''))
    ),
  ];
  return { ciks: allCiks.slice(0, 5), totalMatches: allCiks.length };
}

// A fund's own NPORT-P filing history with a clean registrant name.
// Reuses fetchSubmissionsAllPages (the same helper the Private Credit flow
// already relies on) rather than reading only the submissions API's
// "recent" block directly — that block is capped across ALL of a filer's
// form types combined, not just NPORT-P, so a filing-heavy multi-series
// trust can push its own older NPORT-P filings out of "recent" entirely.
// Confirmed live against a real registrant: American Funds Insurance
// Series (CIK 729528) has filed NPORT-P since the form existed in 2019,
// but a "recent"-only read silently truncated its history to 2022+ —
// fetchSubmissionsAllPages' pagination into "files" is what recovers the
// missing 2019-2021 filings.
// Cached with the same short TTL as other search-result listings (new
// filings appear over time) — this is called on nearly every Fund X-Ray
// interaction (manual search, the Top Funds "verify periods" lookup below,
// and the index build script), so caching it here benefits all of them at
// once instead of each caller re-fetching a CIK's full submissions history
// from EDGAR on every request.
async function fetchFundNportHistory(cik) {
  const cacheKey = cache.searchKey('search:fundhistory', cik);
  const cached = cache.getSearch(cacheKey);
  if (cached) return cached;

  return cache.withInFlight(cacheKey, async () => {
    await delay(50);
    const cikPadded = cik.padStart(10, '0');
    const { name, entries } = await fetchSubmissionsAllPages(cikPadded);
    const filings = entries
      .filter(f => f.form === 'NPORT-P' && f.accessionNumber)
      .map(f => ({ accession: f.accessionNumber, filingDate: f.filingDate || '', reportDate: f.reportDate || '' }));
    const result = { cik, name: name || cik, filings };
    cache.setSearch(cacheKey, result);
    return result;
  });
}

// Compatibility layer (see /api/search-nport above): the fund page reads
// /api/funds; these answer only when the warehouse is unavailable.
app.get('/api/search-fund', async (req, res) => {
  const { fund } = req.query;
  if (!fund) return res.status(400).json({ error: 'fund parameter required' });

  // v2: switched from full-text-search (matched filing content, so a fund
  // name mostly returned unrelated funds mentioning it — see comment above)
  // to a company-name lookup returning { matches }. Namespace bumped so any
  // pre-fix cached response (the old raw EFTS shape) is a miss, not a stale
  // hit — search-cache keys aren't version-gated the way holdings-cache
  // keys are via PARSE_VERSION, so this is done by hand here.
  const cacheKey = cache.searchKey('search:fundxray:v2', fund);
  if (!wantsRefresh(req)) {
    const cached = cache.getSearch(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });
  }

  try {
    const data = await cache.withInFlight(cacheKey, async () => {
      const { ciks, totalMatches } = await lookupFundCiks(fund);
      const matches = [];
      for (const cik of ciks) {
        try {
          const match = await fetchFundNportHistory(cik);
          if (match.filings.length) matches.push(match);
          await delay(50);
        } catch (e) {
          console.error('Fund history error for CIK', cik, e.message);
        }
      }
      const payload = { matches, totalMatches };
      cache.setSearch(cacheKey, payload);
      return payload;
    });
    res.json({ ...data, cached: false });
  } catch (error) {
    console.error('Fund search error:', error.message);
    res.status(500).json({ error: publicError(error) });
  }
});

// ── Multi-series registrants ────────────────────────────────────────────────
// A registrant (trust) files one NPORT-P per fund series under ONE CIK, so its
// filing list interleaves many different funds (real case: Fidelity Advisor
// Series I — 500+ filings across dozens of funds; American Funds Insurance
// Series — 1000+). Comparing "the previous filing" or chaining "the last 8
// filings" is only meaningful within ONE series, so series have to be told
// apart first.

// Just the <genInfo> block of a filing (series id/name, report date) — read as
// a stream and cut off as soon as it's seen, so a 1MB filing costs a few KB.
async function fetchFilingHeader(cik, accessionRaw) {
  const accession = String(accessionRaw).replace(/-/g, '');
  const cacheKey = cache.holdingsKey('nportheader', cik, accession);
  const cached = cache.getHoldings(cacheKey);
  if (cached) return cached;

  return cache.withInFlight(cacheKey, async () => {
    const resp = await fetchWithRetry({
      url: `https://www.sec.gov/Archives/edgar/data/${encodeURIComponent(cik)}/${encodeURIComponent(accession)}/primary_doc.xml`,
      method: 'get',
      headers: { 'User-Agent': EFFECTIVE_USER_AGENT },
      responseType: 'stream',
      timeout: 30000,
    });
    const text = await new Promise((resolve, reject) => {
      let buf = '';
      resp.data.on('data', chunk => {
        buf += chunk.toString('utf8');
        if (buf.includes('</genInfo>') || buf.length > 200000) {
          resp.data.destroy();
          resolve(buf);
        }
      });
      resp.data.on('end', () => resolve(buf));
      resp.data.on('error', err => (buf ? resolve(buf) : reject(err)));
    });
    const pick = tag => (text.match(new RegExp(`<(?:\\w+:)?${tag}>([^<]*)</`)) || [])[1]?.trim() || '';
    const header = {
      seriesId: pick('seriesId'),
      seriesName: pick('seriesName'),
      registrantName: pick('regName'),
      reportDate: pick('repPdDate'),
    };
    if (!header.seriesId && !header.seriesName) throw new Error('No series info in filing header');
    cache.setHoldings(cacheKey, header);
    return header;
  });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = await fn(items[i], i);
        } catch (_e) {
          out[i] = null;
        }
      }
    })
  );
  return out;
}

const SERIES_COHORT_DAYS = 100;
const SERIES_COHORT_CAP = 120;

// Lists the fund series a registrant currently files for. multiSeries is
// detected for free from the submissions data (2+ filings for one report date);
// the series NAMES need each recent filing's header.
app.get('/api/fund-series', async (req, res) => {
  const cik = String(req.query.cik || '').replace(/^0+/, '');
  if (!/^\d+$/.test(cik)) return res.status(400).json({ error: 'cik is required' });

  const cacheKey = cache.searchKey('search:fundseries', cik);
  if (!wantsRefresh(req)) {
    const cached = cache.getSearch(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });
  }

  try {
    const payload = await cache.withInFlight(cacheKey, async () => {
      const hist = await fetchFundNportHistory(cik);
      const recent = hist.filings.slice(0, 40);
      const perDate = {};
      recent.forEach(f => (perDate[f.reportDate] = (perDate[f.reportDate] || 0) + 1));
      const multiSeries = Object.values(perDate).some(n => n > 1);
      if (!multiSeries) {
        const single = { cik, registrant: hist.name, multiSeries: false, series: [] };
        cache.setSearch(cacheKey, single);
        return single;
      }

      const newest = Math.max(...hist.filings.map(f => Date.parse(f.filingDate) || 0));
      const cohort = hist.filings
        .filter(f => (Date.parse(f.filingDate) || 0) >= newest - SERIES_COHORT_DAYS * 86400000)
        .slice(0, SERIES_COHORT_CAP);
      const headers = await mapLimit(cohort, 4, f => fetchFilingHeader(cik, f.accession));
      const seen = new Map();
      cohort.forEach((f, i) => {
        const h = headers[i];
        if (!h || !h.seriesId) return;
        if (!seen.has(h.seriesId)) {
          seen.set(h.seriesId, {
            seriesId: h.seriesId,
            seriesName: h.seriesName,
            accession: f.accession,
            reportDate: f.reportDate,
          });
        }
      });
      const series = [...seen.values()].sort((a, b) => a.seriesName.localeCompare(b.seriesName));
      // Two filings for one report date is also what an amendment looks like
      // (real: SkyBridge G II Fund), and some real trusts' filings carry no
      // series id at all (Stone Ridge Trust V) — with fewer than two
      // identifiable funds there is nothing to choose between.
      if (series.length < 2) {
        const single = { cik, registrant: hist.name, multiSeries: false, series: [] };
        cache.setSearch(cacheKey, single);
        return single;
      }
      const result = { cik, registrant: hist.name, multiSeries: true, series };
      cache.setSearch(cacheKey, result);
      return result;
    });
    res.json({ ...payload, cached: false });
  } catch (error) {
    console.error('Fund series error:', error.message);
    res.status(500).json({ error: publicError(error) });
  }
});

// One series' own NPORT-P history, via EDGAR's series-level filing feed (a
// single request), with report dates joined from the registrant's history.
app.get('/api/fund-series-filings', async (req, res) => {
  const cik = String(req.query.cik || '').replace(/^0+/, '');
  const seriesId = String(req.query.seriesId || '').toUpperCase();
  if (!/^\d+$/.test(cik) || !/^S\d{9}$/.test(seriesId)) {
    return res.status(400).json({ error: 'cik and a seriesId like S000012345 are required' });
  }

  const cacheKey = cache.searchKey('search:seriesfilings', cik, seriesId);
  if (!wantsRefresh(req)) {
    const cached = cache.getSearch(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });
  }

  try {
    const payload = await cache.withInFlight(cacheKey, async () => {
      const [feed, hist] = await Promise.all([
        fetchWithRetry({
          url: 'https://www.sec.gov/cgi-bin/browse-edgar',
          method: 'get',
          params: {
            action: 'getcompany',
            CIK: seriesId,
            type: 'NPORT-P',
            dateb: '',
            owner: 'include',
            count: 100,
            output: 'atom',
          },
          headers: { 'User-Agent': EFFECTIVE_USER_AGENT, Accept: 'application/xml' },
          timeout: 20000,
        }),
        fetchFundNportHistory(cik),
      ]);
      const parsed = await new xml2js.Parser({ explicitArray: false }).parseStringPromise(feed.data);
      let entries = parsed?.feed?.entry || [];
      if (!Array.isArray(entries)) entries = [entries];
      const byAccession = new Map(hist.filings.map(f => [f.accession, f]));
      const filings = entries
        .map(e => e?.content)
        .filter(c => c && c['accession-number'] && c['filing-type'] === 'NPORT-P')
        .map(c => {
          const known = byAccession.get(c['accession-number']);
          return {
            accession: c['accession-number'],
            filingDate: c['filing-date'] || '',
            reportDate: known?.reportDate || '',
          };
        })
        .sort((a, b) => (b.reportDate || b.filingDate).localeCompare(a.reportDate || a.filingDate));
      const result = { cik, seriesId, registrant: hist.name, filings };
      cache.setSearch(cacheKey, result);
      return result;
    });
    res.json({ ...payload, cached: false });
  } catch (error) {
    console.error('Series filings error:', error.message);
    res.status(500).json({ error: publicError(error) });
  }
});

// Fetch and parse one NPORT-P filing in full, returning the fund's
// private-vs-public exposure breakdown (Fund X-Ray). Returns { xray, cached }
// on success, throws on failure — shared by the single-period route below
// and the QoQ/YoY comparison route, which needs to fetch two filings.
// cik/accession must already be validated with normalizeCik/normalizeAccession
// (so the same filing requested with vs. without dashes hits one cache key,
// not two SEC fetches for identical content).
async function getFundXray(cik, accession, { refresh } = {}) {
  // Immutable historical filing content, same rationale as /api/parse-nport
  // — cached indefinitely.
  const cacheKey = cache.holdingsKey('fundxray', cik, accession);
  if (!refresh) {
    const cached = cache.getHoldings(cacheKey);
    if (cached) return { xray: cached, cached: true };
  }

  const xray = await cache.withInFlight(cacheKey, async () => {
    await delay(50);

    const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${encodeURIComponent(cik)}/${encodeURIComponent(accession)}/primary_doc.xml`;
    const xmlResponse = await fetchWithRetry({
      url: xmlUrl,
      method: 'get',
      headers: { 'User-Agent': EFFECTIVE_USER_AGENT },
      timeout: 30000,
    });

    const parser = new xml2js.Parser({
      explicitArray: false,
      mergeAttrs: true,
      normalizeTags: true,
      tagNameProcessors: [xml2js.processors.stripPrefix],
    });

    const result = await parser.parseStringPromise(xmlResponse.data);
    const fundMeta = extractFundMeta(result);
    const holdings = extractAllHoldings(result);
    const xrayResult = buildFundXRay(holdings, fundMeta);
    cache.setHoldings(cacheKey, xrayResult);
    return xrayResult;
  });

  return { xray, cached: false };
}

app.get('/api/fund-xray', async (req, res) => {
  if (!req.query.cik || !req.query.accession) {
    return res.status(400).json({ error: 'cik and accession are required' });
  }
  const cik = normalizeCik(req.query.cik);
  const accession = normalizeAccession(req.query.accession);
  if (!cik || !accession) {
    return res.status(400).json({ error: 'cik must be up to 10 digits and accession 18 digits (dashes allowed)' });
  }

  try {
    const { xray, cached } = await getFundXray(cik, accession, { refresh: wantsRefresh(req) });
    res.json({ success: true, xray, cached });
  } catch (error) {
    console.error('Fund X-Ray error:', error.message);
    res.json({ success: false, xray: null, error: publicError(error) });
  }
});

// Diffs two of the same fund's filings (QoQ or YoY) into a private-equity
// comparison: new/exited investments and share/value/price-per-share/%-of-NAV
// deltas for positions held in both periods.
app.get('/api/fund-xray-compare', async (req, res) => {
  if (!req.query.cik || !req.query.currentAccession || !req.query.priorAccession) {
    return res.status(400).json({ error: 'cik, currentAccession and priorAccession are required' });
  }
  const cik = normalizeCik(req.query.cik);
  const currentAccession = normalizeAccession(req.query.currentAccession);
  const priorAccession = normalizeAccession(req.query.priorAccession);
  if (!cik || !currentAccession || !priorAccession) {
    return res.status(400).json({ error: 'cik must be up to 10 digits and accessions 18 digits (dashes allowed)' });
  }
  const refresh = wantsRefresh(req);
  if (currentAccession === priorAccession) {
    return res.status(400).json({ error: 'currentAccession and priorAccession must be different filings' });
  }

  try {
    const [currentResult, priorResult] = await Promise.all([
      getFundXray(cik, currentAccession, { refresh }),
      getFundXray(cik, priorAccession, { refresh }),
    ]);
    const comparison = buildFundXRayComparison(currentResult.xray, priorResult.xray);
    res.json({ success: true, comparison, cached: currentResult.cached && priorResult.cached });
  } catch (error) {
    console.error('Fund X-Ray compare error:', error.message);
    res.json({ success: false, comparison: null, error: publicError(error) });
  }
});

// Mark-implied returns: lot accounting across several of one fund's own
// filings (cost is a proxy built from marks — NPORT-P has no cost basis).
// Capped so one request can't fan out into dozens of SEC fetches.
const MAX_RETURN_FILINGS = 12;
app.get('/api/fund-xray-returns', async (req, res) => {
  const cik = normalizeCik(req.query.cik);
  const rawList = String(req.query.accessions || '')
    .split(',')
    .map(a => a.trim())
    .filter(Boolean);
  if (!req.query.cik || rawList.length < 2) {
    return res.status(400).json({ error: 'cik and at least two comma-separated accessions are required' });
  }
  if (rawList.length > MAX_RETURN_FILINGS) {
    return res.status(400).json({ error: `at most ${MAX_RETURN_FILINGS} filings per request` });
  }
  const list = rawList.map(normalizeAccession);
  if (!cik || list.some(a => !a)) {
    return res.status(400).json({ error: 'cik must be up to 10 digits and accessions 18 digits (dashes allowed)' });
  }
  const refresh = wantsRefresh(req);

  try {
    const periods = [];
    for (const acc of [...new Set(list)]) {
      const { xray } = await getFundXray(cik, acc, { refresh });
      periods.push({ reportDate: xray.fund?.reportDate || '', xray });
    }
    const returns = buildPositionReturns(periods);
    res.json({ success: true, returns });
  } catch (error) {
    console.error('Fund X-Ray returns error:', error.message);
    res.json({ success: false, returns: null, error: publicError(error) });
  }
});

// Only actually bind a port when this file is run directly (`node server.js`
// / `npm start`) — not when required by a test, so integration tests can
// drive `app` in-process via supertest without opening a real socket.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n✅ Vantage running at http://localhost:${PORT}`);
    console.log(`   User-Agent: ${EFFECTIVE_USER_AGENT}\n`);
    warehouseApi.warm().then(w => {
      console.log(
        w.error ? `   Warehouse: ${w.error}` : `   Warehouse warmed: ${w.companies} tracked companies in ${w.ms} ms`
      );
    });
  });
}

module.exports = app;
