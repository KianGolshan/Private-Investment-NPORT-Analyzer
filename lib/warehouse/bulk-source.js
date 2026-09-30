// Where SEC DERA N-PORT bulk datasets come from: the list of published
// quarters, and a verified download of one quarter's zip. Shared by
// scripts/ingest-bulk.js and scripts/refresh.js.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fetchWithRetry } = require('../edgar');

const DATASET_PAGE = 'https://www.sec.gov/data-research/sec-markets-data/form-n-port-data-sets';
const zipUrl = quarter => `https://www.sec.gov/files/dera/data/form-n-port-data-sets/${quarter}_nport.zip`;

function secUserAgent() {
  const ua = String(process.env.SEC_USER_AGENT || '').trim();
  if (!ua) throw new Error('SEC_USER_AGENT is required (see .env.example)');
  return ua;
}

// Quarters the SEC currently publishes, oldest first (e.g. ['2019q4', …]).
async function listAvailableQuarters() {
  const resp = await fetchWithRetry({
    url: DATASET_PAGE,
    method: 'get',
    headers: { 'User-Agent': secUserAgent() },
    timeout: 30000,
  });
  const found = [...String(resp.data).matchAll(/form-n-port-data-sets\/(\d{4}q[1-4])_nport\.zip/g)].map(m => m[1]);
  if (!found.length) throw new Error('no quarters found on the SEC dataset page');
  return [...new Set(found)].sort();
}

// Streams one quarter's zip to `dir`, hashing as it goes; rejects a
// truncated body. Retries through fetchWithRetry's throttle handling.
async function downloadQuarter(quarter, dir) {
  const dest = path.join(dir, `${quarter}_nport.zip`);
  const resp = await fetchWithRetry({
    url: zipUrl(quarter),
    method: 'get',
    headers: { 'User-Agent': secUserAgent() },
    responseType: 'stream',
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    resp.data.on('data', chunk => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    resp.data.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    resp.data.pipe(out);
  });
  const expected = Number(resp.headers['content-length']);
  if (Number.isFinite(expected) && expected > 0 && expected !== bytes) {
    fs.rmSync(dest, { force: true });
    throw new Error(`truncated download of ${quarter} (${bytes} of ${expected} bytes)`);
  }
  return { path: dest, sha256: hash.digest('hex'), bytes, url: zipUrl(quarter) };
}

// The size of the zip the SEC serves now (HEAD), or null when it doesn't say.
// The SEC re-posts old quarters: every 2019q4-2024q2 zip carries a July 2024
// Last-Modified (DATA-QUALITY trap 41), so a loaded quarter can change.
async function publishedZipBytes(quarter) {
  const resp = await fetchWithRetry({
    url: zipUrl(quarter),
    method: 'head',
    headers: { 'User-Agent': secUserAgent() },
    timeout: 30000,
  });
  const n = Number(resp.headers['content-length']);
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = { listAvailableQuarters, downloadQuarter, publishedZipBytes, zipUrl, secUserAgent, DATASET_PAGE };
