require('dotenv').config();
const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const cheerio = require('cheerio');
const rateLimit = require('express-rate-limit');
const cache = require('./cache');
const { extractHoldings, extractCreditHoldings } = require('./parsers');

const app = express();
// The frontend is served from this same Express instance (express.static
// below) and never needs to call /api/* cross-origin — so no CORS grant is
// needed at all. Without this, cors() with no options reflects any Origin
// header back with credentials-less wildcard access, letting any external
// website's JS call these SEC-proxying endpoints on a visitor's behalf.
app.use(express.json());
app.use(express.static('public'));

const USER_AGENT = process.env.SEC_USER_AGENT || '';
const EFFECTIVE_USER_AGENT = USER_AGENT || 'NPORT-Analyzer internal-tool@localhost';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

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
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down and try again shortly.' },
});
app.use('/api/', apiLimiter);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Retry SEC requests on 429 (rate limit) with exponential backoff.
// SEC's fair-access guidance is ~10 req/sec; transient 429s should be
// retried rather than silently treated as "no data" by callers.
async function fetchWithRetry(config, maxRetries = 3) {
  let attempt = 0;
  for (;;) {
    try {
      return await axios(config);
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < maxRetries) {
        await delay(500 * Math.pow(2, attempt));
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

// Fetch a filer's complete filing history from the EDGAR submissions API,
// flattening the paginated "files" (older filings) alongside "recent".
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
  return entries;
}

// Strip trailing ticker/CIK parentheticals from EFTS display names,
// e.g. "FS KKR Capital Corp (FSK)" -> "FS KKR Capital Corp".
function cleanFilerName(raw) {
  const name = String(raw || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
  return name || String(raw || 'Unknown');
}

// Config endpoint — lets the frontend show a warning if user-agent isn't set
app.get('/api/config', (_req, res) => {
  res.json({ userAgentConfigured: !!USER_AGENT });
});

// Search for NPORT-P filings matching a security name/ticker
app.get('/api/search-nport', async (req, res) => {
  const { security, refresh } = req.query;
  if (!security) return res.status(400).json({ error: 'security parameter required' });

  const cacheKey = cache.searchKey('search:nport', security);
  if (!refresh) {
    const cached = cache.getSearch(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });
  }

  try {
    const data = await cache.withInFlight(cacheKey, async () => {
      const response = await fetchWithRetry({
        url: 'https://efts.sec.gov/LATEST/search-index',
        method: 'get',
        params: {
          q: security,
          category: 'form-cat1',
          forms: 'NPORT-P',
          page: 1,
          from: 0,
          size: 100,
        },
        headers: {
          'User-Agent': EFFECTIVE_USER_AGENT,
          Accept: 'application/json',
        },
        timeout: 30000,
      });
      cache.setSearch(cacheKey, response.data);
      return response.data;
    });
    res.json({ ...data, cached: false });
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Fetch and parse a single NPORT-P XML filing, returning matching holdings
app.get('/api/parse-nport', async (req, res) => {
  const { cik, accession, security, refresh } = req.query;
  if (!cik || !accession || !security) {
    return res.status(400).json({ error: 'cik, accession, and security are required' });
  }

  // A given (cik, accession, security) is a specific historical filing's
  // content — it never changes, so this is cached indefinitely (no TTL).
  const cacheKey = cache.holdingsKey('holdings:nport', cik, accession, security);
  if (!refresh) {
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
      const accessionFormatted = accession.replace(/-/g, '');
      await delay(50);

      const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${encodeURIComponent(cik)}/${encodeURIComponent(accessionFormatted)}/primary_doc.xml`;
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
    res.json({ success: false, holdings: [], error: error.message });
  }
});

// ── Private Credit: Search BDC 10-Q filings ───────────────────────────────
// BDC identification strategy: SEC EDGAR assigns Investment Company Act file
// numbers starting with "814-" to Business Development Companies. This is
// present on every EFTS search hit and is authoritative — no hard-coded CIK
// lists needed. We first pull EFTS full-text-search hits that actually
// mention the issuer (confirmed), then fetch each identified BDC's complete
// 10-Q filing history via the submissions API to close gaps where EFTS may
// not surface every quarter for older filings.
app.get('/api/search-10q', async (req, res) => {
  const { issuer, maxPerFund, refresh } = req.query;
  if (!issuer) return res.status(400).json({ error: 'issuer parameter required' });
  const maxPerFundNum = maxPerFund ? parseInt(maxPerFund, 10) : null;

  const cacheKey = cache.searchKey('search:10q', issuer, maxPerFund || '');
  if (!refresh) {
    const cached = cache.getSearch(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });
  }

  try {
    const result = await cache.withInFlight(cacheKey, async () => {
      const searchResp = await fetchWithRetry({
        url: 'https://efts.sec.gov/LATEST/search-index',
        method: 'get',
        params: { q: `"${issuer}"`, forms: '10-Q', from: 0, size: 200 },
        headers: { 'User-Agent': EFFECTIVE_USER_AGENT, Accept: 'application/json' },
        timeout: 30000,
      });
      const hits = searchResp.data?.hits?.hits || [];

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
          const allFilings = await fetchSubmissionsAllPages(cikPadded);
          let count = 0;
          for (const f of allFilings) {
            if (f.form !== '10-Q') continue;
            if (maxPerFundNum && count >= maxPerFundNum) break;
            const acc = f.accessionNumber || '';
            if (!acc || confirmedAccessions.has(acc)) {
              count++;
              continue;
            }
            historical.push({
              cik: cikStripped,
              accession: acc,
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
    res.status(500).json({ error: error.message });
  }
});

// ── Private Credit: Parse a single 10-Q filing ────────────────────────────
app.get('/api/parse-10q', async (req, res) => {
  const { cik, accession, issuer, reportDate, refresh } = req.query;
  if (!cik || !accession || !issuer) {
    return res.status(400).json({ error: 'cik, accession, and issuer are required' });
  }

  // Same rationale as /api/parse-nport: a given (cik, accession, issuer,
  // reportDate) is a specific historical filing's content — immutable —
  // so it's cached indefinitely.
  const cacheKey = cache.holdingsKey('holdings:10q', cik, accession, issuer, reportDate || '');
  if (!refresh) {
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
      const accNodash = accession.replace(/-/g, '');
      await delay(100);

      // Use the EDGAR submissions API to find the primary document
      const cikPadded = String(cik).replace(/^0+/, '').padStart(10, '0');
      let mainDocName = null;
      try {
        const allFilings = await fetchSubmissionsAllPages(cikPadded);
        const match = allFilings.find(
          f => f.accessionNumber === accession || f.accessionNumber?.replace(/-/g, '') === accNodash
        );
        if (match?.primaryDocument) mainDocName = match.primaryDocument;
      } catch (e) {
        console.error('Submissions API error:', e.message);
      }

      if (!mainDocName) {
        throw new Error('Could not locate main 10-Q document via submissions API');
      }

      const docUrl = `https://www.sec.gov/Archives/edgar/data/${encodeURIComponent(cik)}/${encodeURIComponent(accNodash)}/${encodeURIComponent(mainDocName)}`;
      const htmlResp = await fetchWithRetry({
        url: docUrl,
        method: 'get',
        headers: { 'User-Agent': EFFECTIVE_USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
        timeout: 60000,
        maxContentLength: 25 * 1024 * 1024,
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
    res.json({ success: false, holdings: [], error: error.message });
  }
});

// Only actually bind a port when this file is run directly (`node server.js`
// / `npm start`) — not when required by a test, so integration tests can
// drive `app` in-process via supertest without opening a real socket.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n✅ NPORT Analyzer running at http://localhost:${PORT}`);
    console.log(`   User-Agent: ${EFFECTIVE_USER_AGENT}\n`);
  });
}

module.exports = app;
