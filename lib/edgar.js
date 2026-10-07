// Paced, retrying HTTP client for SEC endpoints, shared by the Express server
// and the warehouse jobs so every outbound request in a process draws from
// one pacing budget. Moved unchanged from server.js (Phase 2).
const axios = require('axios');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Applied to every SEC request unless a call site sets its own (larger,
// for the 10-Q HTML fetch) limit — without a bound, a pathological or
// unexpectedly huge upstream response (submissions JSON, NPORT XML) is
// buffered into memory in full before axios/xml2js ever get a chance to
// reject it.
const DEFAULT_MAX_CONTENT_LENGTH = 25 * 1024 * 1024;

// SEC's fair-access limit is ~10 requests/second per source. Heavy flows
// (series discovery reads dozens of filing headers, returns fetch 8+ filings,
// Watchlist runs fire hundreds of searches) can exceed that in a burst and get
// throttled — first with 429, and after sustained bursts with 503/429 for
// minutes, which was reproduced against the live SEC during testing. So
// outbound requests are paced process-wide, and throttled responses are
// retried patiently (honoring Retry-After) instead of surfacing as failures.
// SEC_MIN_INTERVAL_MS: a negative or unreadable value is the default; 0 (no
// pacing) is for the offline test suite only, and production never goes below
// 100 ms, about 10 requests/s (staff full-stack review R11). The budget is per
// process: a web server and a refresh sharing one address share the SEC's limit
// too (a cross-process budget is a P9 item).
const DEFAULT_INTERVAL_MS = 110;
const PRODUCTION_FLOOR_MS = 100;
function minIntervalMs(raw = process.env.SEC_MIN_INTERVAL_MS, production = process.env.NODE_ENV === 'production') {
  const n = raw === undefined || raw === '' ? DEFAULT_INTERVAL_MS : Number(raw);
  const v = Number.isFinite(n) && n >= 0 ? n : DEFAULT_INTERVAL_MS;
  return production ? Math.max(v, PRODUCTION_FLOOR_MS) : v;
}
const MIN_INTERVAL_MS = minIntervalMs();
let nextSlotAt = 0;
async function pace() {
  if (!MIN_INTERVAL_MS) return;
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + MIN_INTERVAL_MS;
  if (at > now) await delay(at - now);
}

const THROTTLE_STATUS = new Set([429, 503]);
// Occasional transient server errors (seen live from EFTS under load) get a couple of retries.
const TRANSIENT_STATUS = new Set([500, 502, 504]);
const MAX_TRANSIENT_RETRIES = 2;
async function fetchWithRetry(config, maxRetries = 5) {
  const configWithLimit = {
    maxContentLength: DEFAULT_MAX_CONTENT_LENGTH,
    maxBodyLength: DEFAULT_MAX_CONTENT_LENGTH,
    ...config,
  };
  let attempt = 0;
  for (;;) {
    try {
      await pace();
      return await axios(configWithLimit);
    } catch (err) {
      const status = err.response?.status;
      const retryable =
        (THROTTLE_STATUS.has(status) && attempt < maxRetries) ||
        (TRANSIENT_STATUS.has(status) && attempt < MAX_TRANSIENT_RETRIES);
      if (retryable) {
        const retryAfter = Number(err.response?.headers?.['retry-after']);
        const backoff = 500 * Math.pow(2, attempt);
        await delay(Math.min(30000, Math.max(backoff, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)));
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

module.exports = { fetchWithRetry, pace, delay, minIntervalMs, DEFAULT_MAX_CONTENT_LENGTH };
