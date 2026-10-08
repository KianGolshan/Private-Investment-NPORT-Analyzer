// P8 W2: backups, the restore drill and the nightly run (ROADMAP §8, review R09).
// A backup is a verified copy of the published generation; a restore checks its
// SHA-256 and publishes it as a new generation, onto an empty host or over a
// live warehouse; the nightly run alerts when a step fails.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { tmpDir, removeTmp } = require('./helpers/tmp');
const { goldenWarehouse } = require('./helpers/warehouseApp');
const { openWarehouseReadOnly, generationOf } = require('../lib/warehouse/db');
const { warehouseRouter } = require('../lib/api/warehouse');
const { runJob, rollback, restoreBackup, publishedFile, jobState } = require('../lib/warehouse/job');
const { backup, listBackups } = require('../lib/warehouse/backup');
const { nightly, lastNightly } = require('../lib/warehouse/nightly');
const { doctor } = require('../lib/warehouse/doctor');
const company = require('../lib/services/company');

test.afterEach(removeTmp);

let golden;
function tmpWarehouse() {
  golden ??= goldenWarehouse().db.serialize();
  const dir = tmpDir('backup-wh');
  const dbPath = path.join(dir, 'warehouse.db');
  fs.writeFileSync(dbPath, golden);
  return { dir, dbPath };
}
const RENAME = "UPDATE companies SET name = 'Anthropic (renamed in a job)' WHERE name = 'Anthropic'";
const counts = dbPath => {
  const db = openWarehouseReadOnly(dbPath);
  try {
    return Object.fromEntries(
      ['filings', 'holdings', 'companies', 'position_facts', 'curation_snapshot'].map(t => [
        t,
        db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n,
      ])
    );
  } finally {
    db.close();
  }
};
// A golden answer through the service the app uses: Anthropic's holders and total.
const anthropic = dbPath => {
  const db = openWarehouseReadOnly(dbPath);
  try {
    const id = db.prepare("SELECT id FROM companies WHERE name LIKE 'Anthropic%'").get().id;
    const e = company.exposure(db, { companyId: id }, '2026-06-30');
    return { funds: e.funds, total: e.total, accessions: e.holdings.map(h => h.accession).sort() };
  } finally {
    db.close();
  }
};

test('backup: a verified copy of the published generation; the same generation twice is one backup; rotation keeps the newest', async () => {
  const { dbPath } = tmpWarehouse();
  const dir = tmpDir('backups');
  const g1 = await runJob('curation', () => ({}), { dbPath });
  const b1 = backup(dbPath, { dir });
  assert.equal(b1.generation, g1.generation);
  assert.equal(b1.skipped, false);
  assert.match(path.basename(b1.file), new RegExp(`^vantage-g${g1.generation}-\\d{8}T\\d{6}Z\\.db$`));
  assert.equal(fs.readFileSync(`${b1.file}.sha256`, 'utf8'), `${b1.sha256}  ${path.basename(b1.file)}\n`);
  assert.deepEqual(fs.readFileSync(b1.file), fs.readFileSync(publishedFile(dbPath)), 'byte for byte');
  assert.equal(fs.statSync(b1.file).mode & 0o777, 0o444, 'read-only');
  // nothing new published: skipped
  const again = backup(dbPath, { dir });
  assert.deepEqual([again.skipped, again.file], [true, b1.file]);
  // three generations, keep 2
  const stamps = ['2026-10-01T06:15:00Z', '2026-10-02T06:15:00Z', '2026-10-03T06:15:00Z'];
  for (const at of stamps) {
    await runJob('curation', () => ({}), { dbPath });
    backup(dbPath, { dir, keep: 2, now: new Date(at) });
  }
  const list = listBackups(dir);
  assert.equal(list.length, 2);
  assert.ok(list.every(b => b.verified));
  assert.deepEqual(
    list.map(b => b.generation),
    [g1.generation + 3, g1.generation + 2]
  );
  assert.deepEqual(
    fs.readdirSync(dir).filter(f => f.endsWith('.sha256')).length,
    2,
    'old checksums go with their backups'
  );
});

test('backup: refuses without room, leaves no partial file, and a later backup clears a killed one', async () => {
  const { dbPath } = tmpWarehouse();
  const dir = tmpDir('backups');
  await runJob('curation', () => ({}), { dbPath });
  assert.throws(
    () => backup(dbPath, { dir, freeBytes: () => 1000 }),
    err => err.status === 507
  );
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.writeFileSync(path.join(dir, 'vantage-g1-20261001T000000Z.db.partial'), 'killed mid-copy');
  const b = backup(dbPath, { dir });
  assert.deepEqual(b.removed, ['vantage-g1-20261001T000000Z.db.partial']);
  assert.throws(
    () => backup(path.join(tmpDir('none'), 'warehouse.db'), { dir }),
    err => err.status === 404
  );
});

// The drill (ROADMAP §8 "a tested restore onto an empty host"): back up, lose
// the whole warehouse directory, restore into a new one, and the app answers
// the same numbers.
test('restore drill: a backup restored onto an empty host answers the same goldens through the API', async () => {
  const { dbPath } = tmpWarehouse();
  const dir = tmpDir('backups');
  const g = await runJob('curation', db => db.exec(RENAME) && {}, { dbPath });
  const before = { counts: counts(dbPath), anthropic: anthropic(dbPath) };
  assert.ok(before.anthropic.funds > 0 && before.anthropic.total > 0, 'the fixture holds Anthropic');
  const b = backup(dbPath, { dir });

  const host = path.join(tmpDir('empty-host'), 'warehouse.db'); // nothing here: no file, no generations/
  const r = restoreBackup(b.file, host);
  assert.equal(r.from, null);
  assert.equal(r.restores, g.generation);
  assert.equal(r.to, g.generation + 1, 'ids continue from the backup');
  assert.deepEqual(counts(host), before.counts);
  assert.deepEqual(anthropic(host), before.anthropic);
  const db = openWarehouseReadOnly(host);
  const meta = db.prepare('SELECT kind, restores, note FROM generation_meta WHERE id = ?').get(r.to);
  assert.equal(generationOf(db), r.to);
  db.close();
  assert.deepEqual([meta.kind, meta.restores], ['restore', g.generation]);
  assert.match(meta.note, /onto an empty host/);
  assert.equal(jobState(host).kind, 'restore');
  // the app on the restored host
  const app = express().use(
    '/api',
    warehouseRouter(() => openWarehouseReadOnly(host))
  );
  const f = (await request(app).get('/api/freshness').expect(200)).body;
  assert.equal(f.refreshId, r.to);
  assert.match(
    JSON.stringify((await request(app).get('/api/search?q=anthropic').expect(200)).body),
    /renamed in a job/
  );
});

test('restore: a backup whose bytes or checksum are wrong is refused and nothing changes', async () => {
  const { dbPath } = tmpWarehouse();
  const dir = tmpDir('backups');
  await runJob('curation', () => ({}), { dbPath });
  const b = backup(dbPath, { dir });
  const host = path.join(tmpDir('empty-host'), 'warehouse.db');
  // a flipped byte
  const bad = path.join(tmpDir('bad'), path.basename(b.file));
  const bytes = fs.readFileSync(b.file);
  bytes[bytes.length - 100] ^= 0xff;
  fs.writeFileSync(bad, bytes);
  fs.copyFileSync(`${b.file}.sha256`, `${bad}.sha256`);
  assert.throws(
    () => restoreBackup(bad, host),
    err => err.status === 409 && /does not match the recorded/.test(err.message)
  );
  // no checksum at all
  fs.rmSync(`${bad}.sha256`);
  assert.throws(
    () => restoreBackup(bad, host),
    err => err.status === 409 && /no recorded SHA-256/.test(err.message)
  );
  assert.throws(
    () => restoreBackup(path.join(dir, 'missing.db'), host),
    err => err.status === 404
  );
  assert.equal(fs.existsSync(host), false, 'no warehouse was created');
  assert.equal(fs.existsSync(path.join(path.dirname(host), 'generations')), false);
});

test('restore over a live warehouse publishes a new generation; rollback undoes it', async () => {
  const { dbPath } = tmpWarehouse();
  const dir = tmpDir('backups');
  const g1 = await runJob('curation', () => ({}), { dbPath });
  const b = backup(dbPath, { dir });
  const g2 = await runJob('curation', db => db.exec(RENAME) && {}, { dbPath });
  const r = restoreBackup(b.file, dbPath);
  assert.deepEqual([r.from, r.restores], [g2.generation, g1.generation]);
  assert.ok(r.to > g2.generation);
  assert.doesNotMatch(JSON.stringify(anthropic(dbPath)), /renamed/);
  const db = openWarehouseReadOnly(dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM companies WHERE name LIKE '%renamed in a job%'").get().n, 0);
  db.close();
  const back = rollback(dbPath, { to: g2.generation });
  assert.equal(back.restores, g2.generation);
  const db2 = openWarehouseReadOnly(dbPath);
  assert.equal(db2.prepare("SELECT COUNT(*) n FROM companies WHERE name LIKE '%renamed in a job%'").get().n, 1);
  db2.close();
});

test('nightly: every step runs and is recorded; a failure alerts (notification and /fail ping) and the run fails', async () => {
  const { dbPath } = tmpWarehouse();
  const pings = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      pings.push({ url: req.url, body });
      res.end('ok');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/ping/abc`;
  const notified = [];
  const notify = async (title, message) => notified.push({ title, message }) && true;
  try {
    const ok = await nightly(
      dbPath,
      {
        refresh: async () => ({ status: 'ok', detail: 'published' }),
        backup: async () => ({ status: 'ok', detail: 'backed up' }),
        doctor: async () => ({ status: 'warn', detail: 'backup warn: not off-host' }),
      },
      { alertUrl: url, notify }
    );
    assert.equal(ok.status, 'warn');
    assert.deepEqual(notified, [], 'no notification without a failure');
    assert.deepEqual(
      pings.map(p => p.url),
      ['/ping/abc'],
      'success ping'
    );
    assert.equal(lastNightly(dbPath).status, 'warn');

    const order = [];
    const bad = await nightly(
      dbPath,
      {
        refresh: async () => (order.push('refresh'), { status: 'fail', detail: 'exit code 1' }),
        backup: async () => (order.push('backup'), { status: 'ok', detail: 'already backed up' }),
        doctor: async () => {
          order.push('doctor');
          throw new Error('doctor crashed');
        },
      },
      { alertUrl: url, notify }
    );
    assert.deepEqual(order, ['refresh', 'backup', 'doctor'], 'a failed step does not skip the rest');
    assert.equal(bad.status, 'fail');
    assert.deepEqual(
      bad.steps.map(s => [s.name, s.status]),
      [
        ['refresh', 'fail'],
        ['backup', 'ok'],
        ['doctor', 'fail'],
      ]
    );
    assert.equal(notified.length, 1);
    assert.match(notified[0].message, /refresh: exit code 1; doctor: doctor crashed/);
    assert.equal(pings[1].url, '/ping/abc/fail');
    assert.match(pings[1].body, /refresh fail: exit code 1/);
    assert.equal(lastNightly(dbPath).status, 'fail');
    assert.equal(fs.readFileSync(`${dbPath}.nightly.log`, 'utf8').trim().split('\n').length, 2);
    // the doctor reports the failed night
    const d = doctor(dbPath, { tmp: tmpDir('doctor-tmp'), processes: () => [], backups: tmpDir('no-backups') });
    const night = d.checks.find(c => c.name === 'nightly');
    assert.equal(night.status, 'warn');
    assert.match(night.detail, /^fail, .*refresh exit code 1/);
  } finally {
    server.close();
  }
  // an alert channel that is down never fails the night
  const down = await nightly(
    dbPath,
    { refresh: async () => ({ status: 'ok', detail: 'x' }) },
    {
      alertUrl: 'http://127.0.0.1:9/nowhere',
      notify,
    }
  );
  assert.deepEqual([down.status, down.alerts.pinged], ['ok', false]);
});

test('doctor: the backup check says when there is none, when it is behind, and when it is on the same disk', async () => {
  const { dbPath } = tmpWarehouse();
  const dir = tmpDir('backups');
  await runJob('curation', () => ({}), { dbPath });
  const opts = { tmp: tmpDir('doctor-tmp'), processes: () => [], freeBytes: () => 100 * 1024 ** 3, backups: dir };
  const check = () => doctor(dbPath, opts).checks.find(c => c.name === 'backup');
  assert.equal(check().status, 'warn');
  assert.match(check().detail, /^none in /);
  backup(dbPath, { dir });
  // the test's backup directory is on the same disk as the test warehouse
  assert.match(check().detail, /not off-host \(set VANTAGE_BACKUP_DIR\)/);
  await runJob('curation', () => ({}), { dbPath });
  assert.match(check().detail, /behind the published generation/);
});
