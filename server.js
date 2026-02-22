require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const xml2js = require('xml2js');

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ NPORT Analyzer running at http://localhost:${PORT}`);
  console.log(`   User-Agent: ${EFFECTIVE_USER_AGENT}\n`);
});
