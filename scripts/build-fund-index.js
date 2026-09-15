#!/usr/bin/env node
// Builds data/fund-index.json: a convenience list of well-known funds with
// real private-equity (Level 3 equity) exposure in their own NPORT-P
// filings, for Fund X-Ray's "Top Funds" quick-select dropdown.
//
// This is NOT a rigorous cross-fund ranking — it's an easy-access shortlist,
// assembled from two discovery sources that funnel into one CIK pool:
//   1. fund-candidates.js — fund/registrant names resolved to a CIK via the
//      same EDGAR company-name lookup Fund X-Ray's manual search uses
//      (lookupFundCiks). Only works when a candidate string happens to
//      match the registrant's own legal name (EDGAR does a "starts with"
//      match on that, not the fund's marketing name).
//   2. private-company-seeds.js — well-known private companies (SpaceX,
//      OpenAI, Stripe, Databricks, Ramp, ...). Each name is run through the
//      same EDGAR full-text search /api/search-nport uses (restricted to
//      NPORT-P forms), and every fund whose OWN filing actually reports a
//      holding by that name is added directly by CIK — no name-guessing
//      involved, and it catches funds (especially smaller/newer growth
//      funds) that source #1 misses because their marketing name doesn't
//      match their registrant name.
//
// For each unique CIK from either source:
//   - Pull its full NPORT-P filing history and keep only filings from the
//     trailing 3 years — a fund with no filing in that window is dropped.
//   - Parse the SCAN_DEPTH most recent in-window filings (getFundXray) and
//     keep whichever one shows the most private-equity exposure. A single
//     EDGAR "registrant" CIK is often a multi-series trust filing a
//     separate NPORT-P per series each quarter (e.g. one CIK covering a
//     dozen unrelated sibling funds) — always taking the single
//     chronologically-latest filing would pick an arbitrary sibling
//     series, possibly one with zero private exposure, and hide a real
//     holder in the same trust. Scanning a few of the most recent filings
//     and keeping the best one finds the actual flagship series without
//     requiring the candidate list to guess exact series-level names.
// Drop the CIK if none of the scanned filings clears MIN_PRIVATE_VALUE_USD
// (a low materiality floor — just enough to exclude stray few-thousand-
// dollar rounding/legacy positions, not a "big fund only" filter). The
// resulting list is sorted by $ exposure purely so the biggest/most
// obviously relevant holders float to the top of the dropdown, and capped
// at MAX_FUNDS.
//
// Run with `npm run build-fund-index`. Safe to rerun — getFundXray's
// results are cached indefinitely per (cik, accession) in cache.db, so only
// genuinely new filings cost a fresh SEC fetch.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { lookupFundCiks, fetchFundNportHistory, getFundXray } = require('../server');
const candidates = require('../fund-candidates');
const privateCompanySeeds = require('../private-company-seeds');

const MAX_FUNDS = 150;
const WINDOW_YEARS = 3;
const SCAN_DEPTH = 5; // most-recent in-window filings checked per CIK
const DELAY_MS = 150;
// A low materiality floor — just enough to exclude the odd few-thousand-
// dollar legacy/rounding position that isn't really "exposure" to
// anything, not a filter for how large the fund itself needs to be.
const MIN_PRIVATE_VALUE_USD = 1_000_000;

const EFFECTIVE_USER_AGENT = process.env.SEC_USER_AGENT || 'Vantage internal-tool@localhost';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function withinWindow(filing, cutoff) {
  const dateStr = filing.reportDate || filing.filingDate;
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return !Number.isNaN(d.getTime()) && d >= cutoff;
}

// Same EDGAR full-text search endpoint /api/search-nport uses, restricted
// to NPORT-P — returns the CIK of every fund whose own filing mentions this
// security by name (a real holding, since NPORT-P is structured holdings
// data, not prose).
async function discoverCiksByCompany(companyName) {
  const response = await axios.get('https://efts.sec.gov/LATEST/search-index', {
    params: { q: companyName, category: 'form-cat1', forms: 'NPORT-P', page: 1, from: 0, size: 100 },
    headers: { 'User-Agent': EFFECTIVE_USER_AGENT, Accept: 'application/json' },
    timeout: 30000,
  });
  const hits = response.data?.hits?.hits || [];
  const ciks = hits
    .map(h => h._source?.ciks?.[0])
    .filter(Boolean)
    .map(c => String(c).replace(/^0+/, ''));
  return [...new Set(ciks)];
}

async function build() {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - WINDOW_YEARS);

  // cik -> a human-readable label of where it came from, for log messages.
  const cikSources = new Map();

  for (const candidateName of candidates) {
    let ciks;
    try {
      ciks = await lookupFundCiks(candidateName);
    } catch (error) {
      console.error(`[skip] "${candidateName}" — CIK lookup failed: ${error.message}`);
      continue;
    }
    await delay(DELAY_MS);
    for (const cik of ciks) {
      if (!cikSources.has(cik)) cikSources.set(cik, `name lookup: "${candidateName}"`);
    }
  }

  for (const companyName of privateCompanySeeds) {
    let ciks;
    try {
      ciks = await discoverCiksByCompany(companyName);
    } catch (error) {
      console.error(`[skip] discovery for "${companyName}" failed: ${error.message}`);
      continue;
    }
    await delay(DELAY_MS);
    for (const cik of ciks) {
      if (!cikSources.has(cik)) cikSources.set(cik, `holds "${companyName}"`);
    }
  }

  console.log(
    `Discovered ${cikSources.size} unique registrant CIKs from ${candidates.length} fund names + ${privateCompanySeeds.length} companies.\n`
  );

  const results = [];

  for (const [cik, source] of cikSources) {
    let history;
    try {
      history = await fetchFundNportHistory(cik);
    } catch (error) {
      console.error(`[skip] CIK ${cik} (${source}) — history fetch failed: ${error.message}`);
      continue;
    }
    await delay(DELAY_MS);

    const recentFilings = history.filings
      .filter(f => withinWindow(f, cutoff))
      .sort((a, b) => (b.reportDate || b.filingDate).localeCompare(a.reportDate || a.filingDate));
    if (!recentFilings.length) {
      console.log(`[drop] ${history.name} (CIK ${cik}) — no NPORT-P filing in the last ${WINDOW_YEARS} years`);
      continue;
    }

    let best = null; // { filing, xray }
    for (const filing of recentFilings.slice(0, SCAN_DEPTH)) {
      let xray;
      try {
        const parsed = await getFundXray(cik, filing.accession);
        xray = parsed.xray;
      } catch (error) {
        console.error(
          `[skip] ${history.name} (CIK ${cik}) ${filing.accession} — fund-xray parse failed: ${error.message}`
        );
        continue;
      }
      await delay(DELAY_MS);

      if (xray.privateValueUSD > 0 && (!best || xray.privateValueUSD > best.xray.privateValueUSD)) {
        best = { filing, xray };
      }
    }

    if (!best || best.xray.privateValueUSD < MIN_PRIVATE_VALUE_USD) {
      console.log(`[drop] ${history.name} (CIK ${cik}) — no qualifying private-equity exposure`);
      continue;
    }

    const displayName = best.xray.fund?.seriesName || best.xray.fund?.registrantName || history.name;
    console.log(
      `[keep] ${displayName} (CIK ${cik}, ${source}) — $${(best.xray.privateValueUSD / 1e6).toFixed(1)}M PE, ` +
        `${best.xray.privatePctOfNetAssets?.toFixed(1)}% of NAV`
    );

    results.push({
      cik,
      name: displayName,
      latestReportDate: best.filing.reportDate,
      latestAccession: best.filing.accession,
      privateValueUSD: best.xray.privateValueUSD,
      privatePctOfNetAssets: best.xray.privatePctOfNetAssets,
      filings: recentFilings,
    });
  }

  results.sort((a, b) => b.privateValueUSD - a.privateValueUSD);
  const funds = results.slice(0, MAX_FUNDS);

  const output = {
    generatedAt: new Date().toISOString(),
    windowYears: WINDOW_YEARS,
    funds,
  };

  const outPath = path.join(__dirname, '..', 'data', 'fund-index.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\nWrote ${funds.length} funds to ${outPath}`);
}

build().catch(error => {
  console.error('Fund index build failed:', error);
  process.exit(1);
});
