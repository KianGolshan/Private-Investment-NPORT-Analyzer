require('dotenv').config();
const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const cheerio = require('cheerio');
const rateLimit = require('express-rate-limit');
const cache = require('./cache');
const {
  extractHoldings,
  extractCreditHoldings,
  extractFundMeta,
  extractAllHoldings,
  buildFundXRay,
} = require('./parsers');

const app = express();
// The frontend is served from this same Express instance (express.static
// below) and never needs to call /api/* cross-origin — so no CORS grant is
// needed at all. Without this, cors() with no options reflects any Origin
// header back with credentials-less wildcard access, letting any external
// website's JS call these SEC-proxying endpoints on a visitor's behalf.
app.use(express.json());
app.use(express.static('public'));

const USER_AGENT = process.env.SEC_USER_AGENT || '';
const EFFECTIVE_USER_AGENT = USER_AGENT || 'Vantage internal-tool@localhost';
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
          const { entries: allFilings } = await fetchSubmissionsAllPages(cikPadded);
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
        const { entries: allFilings } = await fetchSubmissionsAllPages(cikPadded);
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
  if (singleCik) return [String(singleCik).replace(/^0+/, '')];

  let entries = result?.feed?.entry;
  if (!entries) return [];
  if (!Array.isArray(entries)) entries = [entries];
  const ciks = entries
    .map(e => e?.content?.['company-info']?.cik)
    .filter(Boolean)
    .map(c => String(c).replace(/^0+/, ''));
  return [...new Set(ciks)].slice(0, 5);
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
async function fetchFundNportHistory(cik) {
  const cikPadded = cik.padStart(10, '0');
  const { name, entries } = await fetchSubmissionsAllPages(cikPadded);
  const filings = entries
    .filter(f => f.form === 'NPORT-P' && f.accessionNumber)
    .map(f => ({ accession: f.accessionNumber, filingDate: f.filingDate || '', reportDate: f.reportDate || '' }));
  return { cik, name: name || cik, filings };
}

app.get('/api/search-fund', async (req, res) => {
  const { fund, refresh } = req.query;
  if (!fund) return res.status(400).json({ error: 'fund parameter required' });

  // v2: switched from full-text-search (matched filing content, so a fund
  // name mostly returned unrelated funds mentioning it — see comment above)
  // to a company-name lookup returning { matches }. Namespace bumped so any
  // pre-fix cached response (the old raw EFTS shape) is a miss, not a stale
  // hit — search-cache keys aren't version-gated the way holdings-cache
  // keys are via PARSE_VERSION, so this is done by hand here.
  const cacheKey = cache.searchKey('search:fundxray:v2', fund);
  if (!refresh) {
    const cached = cache.getSearch(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });
  }

  try {
    const data = await cache.withInFlight(cacheKey, async () => {
      const ciks = await lookupFundCiks(fund);
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
      const payload = { matches };
      cache.setSearch(cacheKey, payload);
      return payload;
    });
    res.json({ ...data, cached: false });
  } catch (error) {
    console.error('Fund search error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Fetch and parse one NPORT-P filing in full, returning the fund's
// private-vs-public exposure breakdown (Fund X-Ray).
app.get('/api/fund-xray', async (req, res) => {
  const { cik, accession, refresh } = req.query;
  if (!cik || !accession) {
    return res.status(400).json({ error: 'cik and accession are required' });
  }

  // Immutable historical filing content, same rationale as /api/parse-nport
  // — cached indefinitely.
  const cacheKey = cache.holdingsKey('fundxray', cik, accession);
  if (!refresh) {
    const cached = cache.getHoldings(cacheKey);
    if (cached) return res.json({ success: true, xray: cached, cached: true });
  }

  try {
    const xray = await cache.withInFlight(cacheKey, async () => {
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
      const fundMeta = extractFundMeta(result);
      const holdings = extractAllHoldings(result);
      const xrayResult = buildFundXRay(holdings, fundMeta);
      cache.setHoldings(cacheKey, xrayResult);
      return xrayResult;
    });

    res.json({ success: true, xray, cached: false });
  } catch (error) {
    console.error('Fund X-Ray error:', error.message);
    res.json({ success: false, xray: null, error: error.message });
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
  });
}

module.exports = app;
