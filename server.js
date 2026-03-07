require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const xml2js = require('xml2js');
const cheerio  = require('cheerio');
const { execFile } = require('child_process');
const path         = require('path');

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

// Config endpoint — lets the frontend show a warning if user-agent isn't set
app.get('/api/config', (_req, res) => {
  res.json({ userAgentConfigured: !!USER_AGENT });
});

// Search for NPORT-P filings matching a security name/ticker
app.get('/api/search-nport', async (req, res) => {
  const { security } = req.query;
  if (!security) return res.status(400).json({ error: 'security parameter required' });

  try {
    const response = await axios.get('https://efts.sec.gov/LATEST/search-index', {
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
    res.json(response.data);
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Fetch and parse a single NPORT-P XML filing, returning matching holdings
app.get('/api/parse-nport', async (req, res) => {
  const { cik, accession, security } = req.query;
  if (!cik || !accession || !security) {
    return res.status(400).json({ error: 'cik, accession, and security are required' });
  }

  try {
    const accessionFormatted = accession.replace(/-/g, '');
    await delay(50);

    const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionFormatted}/primary_doc.xml`;
    const xmlResponse = await axios.get(xmlUrl, {
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
    const holdings = extractHoldings(result, security);

    res.json({
      success: true,
      holdings,
      message: holdings.length > 0 ? 'Found holdings' : 'No matching holdings'
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

      const priceInUSD   = valUSD / balance;
      const pricePerShare =
        currencyCode !== 'USD' && exchangeRate > 0 && exchangeRate !== 1
          ? priceInUSD * exchangeRate
          : priceInUSD;

      holdings.push({
        name,
        issuer,
        title,
        shares: balance,
        marketValue: valUSD,
        pricePerShare,
        priceInUSD,
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

// ── Private Credit: Search BDC 10-Q filings via Python/edgartools ─────────
app.get('/api/search-10q', (req, res) => {
  const { issuer, maxPerFund } = req.query;
  if (!issuer) return res.status(400).json({ error: 'issuer parameter required' });

  const scriptPath = path.join(__dirname, 'credit_analyzer.py');
  const args = ['search', issuer];
  if (maxPerFund) args.push(String(maxPerFund));

  execFile('python3', [scriptPath, ...args], {
    env:     { ...process.env, SEC_USER_AGENT: EFFECTIVE_USER_AGENT },
    timeout: 45000,
    maxBuffer: 4 * 1024 * 1024
  }, (err, stdout, stderr) => {
    if (err) {
      console.error('credit_analyzer search error:', err.message, stderr);
      return res.status(500).json({ error: err.message });
    }
    try {
      res.json(JSON.parse(stdout));
    } catch (e) {
      console.error('credit_analyzer bad JSON:', stdout.slice(0, 200));
      res.status(500).json({ error: 'Invalid response from analyzer' });
    }
  });
});

// ── Private Credit: Parse a single 10-Q filing ────────────────────────────
app.get('/api/parse-10q', async (req, res) => {
  const { cik, accession, issuer, reportDate } = req.query;
  if (!cik || !accession || !issuer) {
    return res.status(400).json({ error: 'cik, accession, and issuer are required' });
  }

  try {
    const accNodash = accession.replace(/-/g, '');
    await delay(100);

    // Use the EDGAR submissions API to find the primary document
    const cikPadded = String(cik).replace(/^0+/, '').padStart(10, '0');
    let mainDocName = null;
    try {
      const subUrl = `https://data.sec.gov/submissions/CIK${cikPadded}.json`;
      const subResp = await axios.get(subUrl, {
        headers: { 'User-Agent': EFFECTIVE_USER_AGENT },
        timeout: 15000
      });
      const recent = subResp.data.filings?.recent || {};
      const accList = recent.accessionNumber || [];
      let idx = accList.indexOf(accession);
      // Also try without dashes match
      if (idx < 0) idx = accList.findIndex(a => a.replace(/-/g, '') === accNodash);
      if (idx >= 0 && recent.primaryDocument?.[idx]) {
        mainDocName = recent.primaryDocument[idx];
      }
      // If not in recent filings, check older filing pages
      if (!mainDocName && subResp.data.filings?.files?.length) {
        for (const file of subResp.data.filings.files) {
          const pageResp = await axios.get(`https://data.sec.gov/submissions/${file.name}`, {
            headers: { 'User-Agent': EFFECTIVE_USER_AGENT }, timeout: 10000
          });
          const pageAcc = pageResp.data.accessionNumber || [];
          let pidx = pageAcc.indexOf(accession);
          if (pidx < 0) pidx = pageAcc.findIndex(a => a.replace(/-/g, '') === accNodash);
          if (pidx >= 0 && pageResp.data.primaryDocument?.[pidx]) {
            mainDocName = pageResp.data.primaryDocument[pidx];
            break;
          }
        }
      }
    } catch (e) {
      console.error('Submissions API error:', e.message);
    }

    if (!mainDocName) {
      return res.json({ success: false, holdings: [], error: 'Could not locate main 10-Q document via submissions API' });
    }

    const docUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNodash}/${mainDocName}`;
    const htmlResp = await axios.get(docUrl, {
      headers: { 'User-Agent': EFFECTIVE_USER_AGENT, 'Accept': 'text/html,application/xhtml+xml' },
      timeout: 60000,
      maxContentLength: 25 * 1024 * 1024
    });

    const $ = cheerio.load(htmlResp.data);
    const holdings = extractCreditHoldings($, issuer, reportDate || '');

    res.json({
      success: true,
      holdings,
      message: holdings.length > 0 ? 'Found holdings' : 'No matching holdings'
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
