// Backups of the published warehouse (ROADMAP §8, review R09). A published
// generation never changes (lib/warehouse/job.js), so a backup is a copy of its
// file, verified twice: the copy's SHA-256 must equal the source's, and the
// copy must pass SQLite's quick_check before it gets its final name. Each
// backup sits beside a `<file>.sha256` that restoreBackup (job.js) checks
// before it publishes anything.
//
// Where: VANTAGE_BACKUP_DIR, else ~/Vantage-backups. A directory on the
// warehouse's own disk survives a deleted or corrupted warehouse, not a lost
// disk; `npm run doctor` says which it is. Point VANTAGE_BACKUP_DIR at another
// disk or a synced folder for an off-host copy.
//
// A backup is not a warehouse write (it reads the published file), so it takes
// no job lock and can run beside a job.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { defaultWarehousePath } = require('./db');
const { publishedFile, sha256File, JobError } = require('./job');

const KEEP_BACKUPS = 3; // ~580 MB each
const NAME = /^vantage-g(\d+)-(\d{8}T\d{6}Z)\.db$/;

const backupDir = (env = process.env) => env.VANTAGE_BACKUP_DIR || path.join(os.homedir(), 'Vantage-backups');
const stamp = d =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

// The backups in `dir`, newest first (by generation, then time).
function listBackups(dir = backupDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map(f => ({ f, m: f.match(NAME) }))
    .filter(x => x.m)
    .map(({ f, m }) => {
      const file = path.join(dir, f);
      const st = fs.statSync(file);
      return {
        file,
        generation: Number(m[1]),
        takenAt: st.mtime.toISOString(),
        bytes: st.size,
        verified: fs.existsSync(`${file}.sha256`),
      };
    })
    .sort((a, b) => b.generation - a.generation || b.takenAt.localeCompare(a.takenAt));
}

const freeBytesOf = dir => {
  const st = fs.statfsSync(dir);
  return st.bavail * st.bsize;
};

// Backs up the published generation into `dir`, keeping the newest `keep`
// backups. A generation already backed up (with its checksum) is skipped
// unless `force`. Returns { file, generation, bytes, sha256, skipped, removed }.
function backup(
  dbPath = defaultWarehousePath(),
  {
    dir = backupDir(),
    keep = KEEP_BACKUPS,
    force = false,
    now = new Date(),
    log = () => {},
    freeBytes = freeBytesOf,
  } = {}
) {
  if (!Number.isInteger(keep) || keep < 1) throw new JobError(400, `keep must be a positive integer, got ${keep}`);
  const source = publishedFile(dbPath);
  if (!source) throw new JobError(404, `${dbPath}: no published warehouse to back up`);
  fs.mkdirSync(dir, { recursive: true });
  const src = new Database(source, { readonly: true, fileMustExist: true });
  let generation = null;
  try {
    generation = src.prepare('SELECT MAX(id) id FROM generation_meta').get().id;
  } catch {
    // a warehouse from before generations
  } finally {
    src.close();
  }
  if (generation == null) throw new JobError(409, `${source}: not a warehouse generation (no generation_meta)`);
  const have = listBackups(dir).find(b => b.generation === generation && b.verified);
  if (have && !force) {
    log(`generation ${generation} is already backed up: ${have.file}`);
    return { file: have.file, generation, bytes: have.bytes, skipped: true, removed: rotate(dir, keep, log) };
  }
  const bytes = fs.statSync(source).size;
  const free = freeBytes(dir);
  if (free < bytes * 1.05)
    throw new JobError(
      507,
      `not enough free disk for a backup in ${dir}: ${(free / 1e9).toFixed(2)} GB free, ${(bytes / 1e9).toFixed(2)} GB needed`
    );
  const dest = path.join(dir, `vantage-g${generation}-${stamp(now)}.db`);
  const partial = `${dest}.partial`;
  try {
    // A clone where the filesystem supports it (same APFS volume), else a copy.
    fs.copyFileSync(source, partial, fs.constants.COPYFILE_FICLONE);
    const want = sha256File(source);
    const got = sha256File(partial);
    if (got !== want) throw new JobError(500, `backup copy differs from ${source} (SHA-256 ${got} vs ${want})`);
    const db = new Database(partial, { readonly: true, fileMustExist: true });
    try {
      const check = db.pragma('quick_check', { simple: true });
      if (check !== 'ok') throw new JobError(500, `backup copy fails quick_check: ${check}`);
    } finally {
      db.close();
    }
    fs.chmodSync(partial, 0o444);
    fs.renameSync(partial, dest);
    fs.writeFileSync(`${dest}.sha256`, `${got}  ${path.basename(dest)}\n`);
    log(`backed up generation ${generation} to ${dest} (${(bytes / 1e6).toFixed(1)} MB, sha256 ${got.slice(0, 12)})`);
    return { file: dest, generation, bytes, sha256: got, skipped: false, removed: rotate(dir, keep, log) };
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
}

// Keeps the newest `keep` backups; removes the rest and any `.partial` left by
// a backup that was killed. Returns the names removed.
function rotate(dir, keep, log = () => {}) {
  const removed = [];
  for (const f of fs.readdirSync(dir).filter(f => /^vantage-g\d+-.*\.db\.partial$/.test(f))) {
    fs.rmSync(path.join(dir, f), { force: true });
    removed.push(f);
  }
  for (const b of listBackups(dir).slice(keep)) {
    fs.rmSync(b.file, { force: true });
    fs.rmSync(`${b.file}.sha256`, { force: true });
    removed.push(path.basename(b.file));
  }
  if (removed.length) log(`removed old backups: ${removed.join(', ')}`);
  return removed;
}

module.exports = { backup, listBackups, backupDir, KEEP_BACKUPS };
