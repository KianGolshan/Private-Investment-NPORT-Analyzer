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

// A body that stops arriving without closing would otherwise never settle:
// axios's `timeout` covers the wait for the response, not a streamed body, and
// a job stuck here holds the job lock forever (P8 pre-flight, 2026-10-07).
const DOWNLOAD_IDLE_MS = 60 * 1000;

// Streams one quarter's zip to `dir`, hashing as it goes; rejects a
// truncated body, and a body with no data for idleMs. Retries through
// fetchWithRetry's throttle handling.
async function downloadQuarter(quarter, dir, { idleMs = DOWNLOAD_IDLE_MS } = {}) {
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
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      let timer;
      const fail = err => {
        clearTimeout(timer);
        resp.data.destroy();
        out.destroy();
        reject(err);
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => fail(new Error(`download of ${quarter} stalled: no data for ${idleMs / 1000} s after ${bytes} bytes`)),
          idleMs
        );
      };
      arm();
      resp.data.on('data', chunk => {
        arm();
        hash.update(chunk);
        bytes += chunk.length;
      });
      resp.data.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        clearTimeout(timer);
        resolve();
      });
      resp.data.pipe(out);
    });
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
  const expected = Number(resp.headers['content-length']);
  if (Number.isFinite(expected) && expected > 0 && expected !== bytes) {
    fs.rmSync(dest, { force: true });
    throw new Error(`truncated download of ${quarter} (${bytes} of ${expected} bytes)`);
  }
  return { path: dest, sha256: hash.digest('hex'), bytes, url: zipUrl(quarter) };
}

// What the SEC serves for a quarter's zip now (HEAD): size, Last-Modified and
// ETag (null when not sent). The SEC re-posts old quarters: every 2019q4-2024q2
// zip carries a July 2024 Last-Modified (DATA-QUALITY trap 41). Checked
// 2026-10-05: no ETag is sent; size and Last-Modified are stable across requests.
async function publishedZipHead(quarter) {
  const resp = await fetchWithRetry({
    url: zipUrl(quarter),
    method: 'head',
    headers: { 'User-Agent': secUserAgent() },
    timeout: 30000,
  });
  const n = Number(resp.headers['content-length']);
  return {
    bytes: Number.isFinite(n) && n > 0 ? n : null,
    etag: resp.headers.etag || null,
    lastModified: resp.headers['last-modified'] || null,
  };
}

// The size of the zip the SEC serves now, or null when it doesn't say.
async function publishedZipBytes(quarter) {
  return (await publishedZipHead(quarter)).bytes;
}

module.exports = {
  listAvailableQuarters,
  downloadQuarter,
  publishedZipBytes,
  publishedZipHead,
  zipUrl,
  DOWNLOAD_IDLE_MS,
  secUserAgent,
  DATASET_PAGE,
};
