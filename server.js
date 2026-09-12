require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const xml2js = require('xml2js');
const cheerio  = require('cheerio');
const cache = require('./cache');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const USER_AGENT = process.env.SEC_USER_AGENT || '';
const EFFECTIVE_USER_AGENT = USER_AGENT || 'NPORT-Analyzer internal-tool@localhost';

if (!USER_AGENT) {
  console.warn('\n⚠️  WARNING: SEC_USER_AGENT not set.');
  console.warn('   Copy .env.example to .env and add your name and email.');
  console.warn('   The SEC requires this header for EDGAR API access.\n');
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
  const pushEntries = (block) => {
    const forms      = block.form            || [];
    const accs       = block.accessionNumber || [];
    const fileDates   = block.filingDate      || [];
    const periods     = block.reportDate      || [];
    const primaryDocs = block.primaryDocument || [];
    for (let i = 0; i < accs.length; i++) {
      entries.push({
        form: forms[i], accessionNumber: accs[i],
        filingDate: fileDates[i], reportDate: periods[i],
        primaryDocument: primaryDocs[i]
      });
    }
  };

  const subUrl  = `https://data.sec.gov/submissions/CIK${cikPadded}.json`;
  const subResp = await fetchWithRetry({
    url: subUrl, method: 'get',
    headers: { 'User-Agent': EFFECTIVE_USER_AGENT, 'Accept': 'application/json' },
    timeout: 15000
  });
  pushEntries(subResp.data.filings?.recent || {});

  const files = subResp.data.filings?.files || [];
  for (const file of files) {
    try {
      const pageResp = await fetchWithRetry({
        url: `https://data.sec.gov/submissions/${file.name}`, method: 'get',
        headers: { 'User-Agent': EFFECTIVE_USER_AGENT, 'Accept': 'application/json' },
        timeout: 10000
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
  const name = String(raw || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
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
          size: 100
        },
        headers: {
          'User-Agent': EFFECTIVE_USER_AGENT,
          'Accept': 'application/json'
        },
        timeout: 30000
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
        cached: true
      });
    }
  }

  try {
    const holdings = await cache.withInFlight(cacheKey, async () => {
      const accessionFormatted = accession.replace(/-/g, '');
      await delay(50);

      const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionFormatted}/primary_doc.xml`;
      const xmlResponse = await fetchWithRetry({
        url: xmlUrl, method: 'get',
        headers: { 'User-Agent': EFFECTIVE_USER_AGENT },
        timeout: 30000
      });

      const parser = new xml2js.Parser({
        explicitArray: false,
        mergeAttrs: true,
        normalizeTags: true,
        tagNameProcessors: [xml2js.processors.stripPrefix]
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
      cached: false
    });
  } catch (error) {
    res.json({ success: false, holdings: [], error: error.message });
  }
});

function extractHoldings(xml, securitySearchTerm) {
  const holdings = [];
  try {
    const formData =
      xml.edgarSubmission?.formData ||
      xml.edgarSubmission?.formdata ||
      xml.edgarsubmission?.formData ||
      xml.edgarsubmission?.formdata;

    if (!formData) return holdings;

    const genInfo = formData.genInfo || formData.geninfo || {};
    const reportDate = genInfo.repPdDate || genInfo.reppddate || genInfo.reportDate || '';

    let investments =
      formData.invstOrSecs?.invstOrSec ||
      formData.invstorsecs?.invstorsec ||
      formData.investments?.investment;

    if (!investments) return holdings;
    if (!Array.isArray(investments)) investments = [investments];

    const searchLower = securitySearchTerm.toLowerCase();

    for (const inv of investments) {
      const name      = String(inv.name      || inv.Name      || inv.issuerName || '');
      const issuer    = String(inv.issuer?.name || inv.issuer?.Name || inv.issuerName || '');
      const ticker    = String(inv.identifiers?.ticker || inv.ticker || inv.Ticker || '');
      const title     = String(inv.title || inv.Title || inv.desc || inv.description || '');

      const matches =
        name.toLowerCase().includes(searchLower) ||
        issuer.toLowerCase().includes(searchLower) ||
        ticker.toLowerCase().includes(searchLower);

      if (!matches) continue;

      const balance = parseFloat(inv.balance || inv.Balance || inv.shares || inv.Shares || 0);
      const valUSD  = parseFloat(inv.valUSD  || inv.valusd  || inv.marketValue || inv.MarketValue || 0);
      if (!(balance > 0 && valUSD > 0)) continue;

      const currencyCode = String(
        inv.currencyconditional?.curCd || inv.currencyconditional?.curcd ||
        inv.curCd || inv.curcd || inv.currencyCode || inv.currency || 'USD'
      ).trim().toUpperCase();

      const exchangeRate = parseFloat(
        inv.currencyconditional?.exchangeRt || inv.currencyconditional?.exchangert ||
        inv.exchangeRt || inv.exchangert || inv.exchangeRate ||
        inv.fxRate || inv.fxrate || 1
      );

      // NPORT's valUSD is already expressed in USD by schema, so
      // valUSD / balance is already the correct USD price per share.
      // (Previously this was re-multiplied by exchangeRate for non-USD
      // holdings, silently corrupting the price shown for foreign marks.)
      const pricePerShare = valUSD / balance;

      holdings.push({
        name,
        issuer,
        title,
        shares: balance,
        marketValue: valUSD,
        pricePerShare,
        currency: currencyCode,
        exchangeRate,
        reportDate,
        cusip: String(inv.identifiers?.cusip || inv.cusip || inv.CUSIP || ''),
        ticker
      });
    }
  } catch (err) {
    console.error('Error extracting holdings:', err.message);
  }
  return holdings;
}

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
        headers: { 'User-Agent': EFFECTIVE_USER_AGENT, 'Accept': 'application/json' },
        timeout: 30000
      });
      const hits = searchResp.data?.hits?.hits || [];

      const confirmed = [];
      const bdcCikName = {};          // { "1422183": "FS KKR Capital Corp" }
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
          cik, accession, company: name,
          period:   src.period_ending || src.file_date || '',
          fileDate: src.file_date || '',
          confirmed: true
        });
        if (accession) confirmedAccessions.add(accession);
      }

      const historical = [];
      for (const [cikStripped, name] of Object.entries(bdcCikName)) {
        try {
          const cikPadded   = cikStripped.padStart(10, '0');
          const allFilings  = await fetchSubmissionsAllPages(cikPadded);
          let count = 0;
          for (const f of allFilings) {
            if (f.form !== '10-Q') continue;
            if (maxPerFundNum && count >= maxPerFundNum) break;
            const acc = f.accessionNumber || '';
            if (!acc || confirmedAccessions.has(acc)) { count++; continue; }
            historical.push({
              cik: cikStripped, accession: acc, company: name,
              period: f.reportDate || '', fileDate: f.filingDate || '',
              confirmed: false
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
        filings:   [...confirmed, ...historical],
        bdcFunds:  [...new Set(Object.values(bdcCikName))].sort(),
        confirmed: confirmed.length,
        total:     confirmed.length + historical.length
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
        cached: true
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
        const match = allFilings.find(f =>
          f.accessionNumber === accession ||
          f.accessionNumber?.replace(/-/g, '') === accNodash
        );
        if (match?.primaryDocument) mainDocName = match.primaryDocument;
      } catch (e) {
        console.error('Submissions API error:', e.message);
      }

      if (!mainDocName) {
        throw new Error('Could not locate main 10-Q document via submissions API');
      }

      const docUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNodash}/${mainDocName}`;
      const htmlResp = await fetchWithRetry({
        url: docUrl, method: 'get',
        headers: { 'User-Agent': EFFECTIVE_USER_AGENT, 'Accept': 'text/html,application/xhtml+xml' },
        timeout: 60000,
        maxContentLength: 25 * 1024 * 1024
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
      cached: false
    });
  } catch (error) {
    console.error('10-Q parse error:', error.message);
    res.json({ success: false, holdings: [], error: error.message });
  }
});

// ── Private Credit helpers ─────────────────────────────────────────────────

function parseFinancialNumber(str) {
  if (str == null) return null;
  const s = String(str).replace(/[$,\s]/g, '').trim();
  if (!s || s === '—' || s === '-' || s === '–') return null;
  const neg = s.startsWith('(') && s.endsWith(')');
  const n = parseFloat(neg ? '-' + s.slice(1, -1) : s);
  return isNaN(n) ? null : n;
}

function getRowCells($, row, expandColspan) {
  const cells = [];
  $(row).find('td, th').each((_, cell) => {
    const text = $(cell).text().replace(/\s+/g, ' ').trim();
    if (expandColspan) {
      const colspan = parseInt($(cell).attr('colspan') || '1');
      for (let i = 0; i < colspan; i++) cells.push(text);
    } else {
      cells.push(text);
    }
  });
  return cells;
}

function tryBuildCreditColumnMap(cells) {
  const map = {};
  const MATCHERS = [
    ['portfolioCompany', c => c.includes('portfolio company') || c === 'company' || c === 'portfolio'],
    ['industry',         c => c.startsWith('industry')],
    ['investmentType',   c => c.includes('type of investment') || c.includes('investment type') || (c.includes('type') && c.includes('invest'))],
    ['index',            c => c === 'index' || c.startsWith('index ')],
    ['spread',           c => c.startsWith('spread')],
    ['cashInterestRate', c => c.includes('cash interest') || (c.includes('interest rate') && !c.includes('pik')) || c.startsWith('current rate') || c.startsWith('rate (')],
    ['pik',              c => c === 'pik' || c.startsWith('pik ')],
    ['maturityDate',     c => c.includes('maturity')],
    ['shares',           c => c.startsWith('shares') || c.startsWith('units/shares') || c === 'units'],
    ['principal',        c => c.startsWith('principal') || c.startsWith('par value') || c.startsWith('par amount') || c === 'par'],
    ['cost',             c => c === 'cost' || c.startsWith('amortized cost') || c.startsWith('cost (')],
    ['fairValue',        c => c.includes('fair value')],
    ['notes',            c => c.startsWith('note') || c.startsWith('footnote')],
  ];

  cells.forEach((raw, i) => {
    // Strip footnote references like (1)(2)(3) and normalize
    const c = raw.toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9 /]/g, ' ').replace(/\s+/g, ' ').trim();
    for (const [field, matcher] of MATCHERS) {
      if (map[field] !== undefined) continue;
      if (matcher(c)) { map[field] = i; }
    }
  });

  // Must have at least fair value and (principal or cost)
  if (map.fairValue === undefined) return null;
  if (map.principal === undefined && map.cost === undefined) return null;
  return map;
}

// Get a cell value, skipping standalone currency-symbol cells ($, £, etc.)
function getCreditCell(cells, idx) {
  if (idx === undefined || idx === null || idx >= cells.length) return '';
  const raw = (cells[idx] || '').trim();
  // If just a currency symbol, look one position ahead for the actual value
  if (/^[$£€¥₩]$|^[A-Z]{1,3}\$$/.test(raw)) {
    return (cells[idx + 1] || '').trim();
  }
  return raw;
}

// Pattern-based extraction of rate/date fields from non-expanded cells.
// Handles filings where the header uses a single wide "Rate" cell (e.g. colspan=15)
// rather than separate Index / Spread / PIK / Maturity header cells.
function extractRateFieldsFromCells(rawCells) {
  const result = { index: '', spread: '', pik: '', maturityDate: '', cashInterestRate: '' };
  const cleanPcts = []; // standalone percentages like "4.8%"

  for (const cell of rawCells) {
    const c = cell.trim();
    if (!c || c === '+' || c === '-' || c === '—' || c === '–') continue;

    // Floating rate benchmark names
    if (!result.index && /^(SF|SOFR|L|LIBOR|EURIBOR|SONIA|PRIME|AMERIBOR|BASE RATE)$/i.test(c)) {
      result.index = c.toUpperCase();
    }

    // Standalone percentage (e.g. "4.8%") — not embedded in longer text
    if (/^\d+\.?\d*%$/.test(c)) {
      cleanPcts.push(c);
    }

    // Maturity date: MM/YY or MM/YYYY
    if (!result.maturityDate && /^\d{1,2}\/\d{2,4}$/.test(c)) {
      result.maturityDate = c;
    }
  }

  if (result.index) {
    // Floating rate: first pct = spread, second = PIK or floor
    if (cleanPcts.length >= 1) result.spread = cleanPcts[0];
    if (cleanPcts.length >= 2) result.pik    = cleanPcts[1];
  } else {
    // Fixed / no-index: first pct = cash interest rate
    if (cleanPcts.length >= 1) result.cashInterestRate = cleanPcts[0];
    // PIK embedded in cell text like "(3.0% PIK)"
    for (const cell of rawCells) {
      const cl = cell.toLowerCase();
      if (cl.includes('pik') && /\d+\.?\d*%/.test(cl)) {
        const m = cl.match(/(\d+\.?\d*)%/);
        if (m) { result.pik = m[1] + '%'; break; }
      }
    }
  }

  return result;
}


function extractCreditHoldings($, issuerSearchTerm, reportDate) {
  const holdings = [];
  const searchLower = issuerSearchTerm.toLowerCase();
  let lastGoodColMap = null; // carry forward into continuation tables

  $('table').each((_, tableEl) => {
    const $table = $(tableEl);
    const allRows = $table.find('tr').toArray();
    if (allRows.length < 2) return;

    let colMap = null;
    let headerRowIdx = -1;

    // Search for a header row using colspan-expanded cells
    for (let i = 0; i < Math.min(allRows.length, 15); i++) {
      const cells = getRowCells($, allRows[i], true);
      const map = tryBuildCreditColumnMap(cells);
      if (map) { colMap = map; headerRowIdx = i; break; }
    }

    // Continuation tables (page 2+ of schedule) have no header — reuse last map
    if (!colMap && lastGoodColMap) {
      colMap = lastGoodColMap;
      headerRowIdx = -1;
    }

    if (!colMap) return;
    lastGoodColMap = colMap;

    let currentCompany = '';
    let currentIndustry = '';

    for (let i = headerRowIdx + 1; i < allRows.length; i++) {
      // Expanded cells for colMap-based financial extraction
      const cells    = getRowCells($, allRows[i], true);
      // Non-expanded cells for pattern-based rate/date extraction
      const rawCells = getRowCells($, allRows[i], false);
      if (cells.length < 5) continue;

      // Carry forward company and industry (BDC tables blank repeated cells)
      const rawCompany  = getCreditCell(cells, colMap.portfolioCompany);
      const rawIndustry = getCreditCell(cells, colMap.industry);
      if (rawCompany.length > 2 && rawCompany !== '—' && rawCompany !== '-') {
        currentCompany = rawCompany;
      }
      if (rawIndustry.length > 2 && rawIndustry !== '—' && rawIndustry !== '-') {
        currentIndustry = rawIndustry;
      }

      if (!currentCompany.toLowerCase().includes(searchLower)) continue;

      const principalStr = getCreditCell(cells, colMap.principal);
      const fairValueStr = getCreditCell(cells, colMap.fairValue);
      const principal    = parseFinancialNumber(principalStr);
      const fairValue    = parseFinancialNumber(fairValueStr);
      if (principal === null && fairValue === null) continue;

      const fairValueMark = (principal && principal !== 0 && fairValue !== null)
        ? (fairValue / principal) * 100 : null;

      // Rate fields: colMap first, fall back to pattern scan of raw cells
      const rf = extractRateFieldsFromCells(rawCells);
      const index            = getCreditCell(cells, colMap.index)            || rf.index;
      const spread           = getCreditCell(cells, colMap.spread)           || rf.spread;
      const pik              = getCreditCell(cells, colMap.pik)              || rf.pik;
      const cashInterestRate = getCreditCell(cells, colMap.cashInterestRate) || rf.cashInterestRate;
      const maturityDate     = getCreditCell(cells, colMap.maturityDate)     || rf.maturityDate;
      const investmentType   = getCreditCell(cells, colMap.investmentType);

      holdings.push({
        reportDate,
        portfolioCompany: currentCompany,
        industry:         rawIndustry.length > 2 ? rawIndustry : currentIndustry,
        investmentType,
        index,
        spread,
        cashInterestRate,
        pik,
        maturityDate,
        shares:    getCreditCell(cells, colMap.shares),
        principal,
        cost:      parseFinancialNumber(getCreditCell(cells, colMap.cost)),
        fairValue,
        fairValueMark,
        notes:     getCreditCell(cells, colMap.notes),
      });
    }
  });

  return holdings;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ NPORT Analyzer running at http://localhost:${PORT}`);
  console.log(`   User-Agent: ${EFFECTIVE_USER_AGENT}\n`);
});
