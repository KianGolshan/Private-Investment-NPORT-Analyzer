// Admin actions (ROADMAP §5b task 8, ADR 0008 decision 6). Local and
// admin-only: every request is refused unless VANTAGE_ADMIN=1, it comes from
// this machine without passing through a proxy, and it carries the
// X-Vantage-Admin header (a cross-site form cannot set one). The server stays
// read-only: the job runs as a child process (scripts/make-company.js) that
// writes the reviewed files and runs the import under the refresh lock.
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

const adminEnabled = () => process.env.VANTAGE_ADMIN === '1';
function isLocalRequest(req) {
  if (req.headers['x-forwarded-for'] || req.headers.forwarded) return false;
  return LOCAL.has(req.socket?.remoteAddress);
}

// Runs the job to its end (it always exits: success, failure or the timeout)
// and returns its JSON line.
// dir: the reviewed files (default data/review; tests pass a copy).
function runMakeCompanyJob({ key, name, status, track, dir }) {
  const script = path.join(__dirname, '..', '..', 'scripts', 'make-company.js');
  const args = [script, '--key', key, '--name', name, '--status', status, '--track', track];
  if (dir) args.push('--dir', dir);
  return new Promise(resolve => {
    execFile(process.execPath, args, { timeout: JOB_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
      const line = String(stdout || '')
        .trim()
        .split('\n')
        .pop();
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ error: err ? `job failed: ${err.message}` : 'job printed no result', status: 500 });
      }
    });
  });
}

function adminRouter({ enabled = adminEnabled, runJob = runMakeCompanyJob } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!enabled()) return res.status(403).json({ error: 'admin actions are off (VANTAGE_ADMIN is not set)' });
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'admin actions are local only' });
    if (req.headers['x-vantage-admin'] !== '1')
      return res.status(403).json({ error: 'missing X-Vantage-Admin header' });
    return next();
  });

  router.post('/companies', express.json({ limit: '10kb' }), async (req, res) => {
    const b = req.body || {};
    const key = String(b.key || '').trim();
    const name = String(b.name || '').trim();
    const status = String(b.status || 'private');
    const track = String(b.track || 'N').toUpperCase();
    if (!key || !name) return res.status(400).json({ error: 'key and name are required' });
    const r = await runJob({ key, name, status, track });
    if (r.error) return res.status(r.status || 500).json({ error: r.error });
    return res.status(201).json(r);
  });
  return router;
}

module.exports = { adminRouter, isLocalRequest, adminEnabled, runMakeCompanyJob };
