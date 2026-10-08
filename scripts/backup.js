#!/usr/bin/env node
// Backs up the published warehouse generation (lib/warehouse/backup.js), or
// restores one (lib/warehouse/job.js restoreBackup) as a new generation.
//
//   npm run backup                              # into VANTAGE_BACKUP_DIR (default ~/Vantage-backups), keep 3
//   npm run backup -- --dir /Volumes/X --keep 5 --force
//   npm run backup -- --list
//   npm run backup -- --restore <file>          # verify its SHA-256, publish it as a new generation
require('dotenv').config();
const { defaultWarehousePath } = require('../lib/warehouse/db');
const { backup, listBackups, backupDir, KEEP_BACKUPS } = require('../lib/warehouse/backup');
const { restoreBackup } = require('../lib/warehouse/job');

function main() {
  const args = process.argv.slice(2);
  const opt = name => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dbPath = defaultWarehousePath();
  const dir = opt('--dir') || backupDir();
  const log = line => console.log(line);
  if (args.includes('--list')) {
    const list = listBackups(dir);
    if (!list.length) console.log(`no backups in ${dir}`);
    for (const b of list)
      console.log(
        `generation ${String(b.generation).padStart(4)}  ${b.takenAt}  ${(b.bytes / 1e6).toFixed(1)} MB  ${b.verified ? 'sha256' : 'NO CHECKSUM'}  ${b.file}`
      );
    return;
  }
  const from = opt('--restore');
  if (from) {
    const r = restoreBackup(from, dbPath, { log });
    console.log(`published generation ${r.to} with the contents of generation ${r.restores}`);
    return;
  }
  const keep = opt('--keep') != null ? Number(opt('--keep')) : KEEP_BACKUPS;
  backup(dbPath, { dir, keep, force: args.includes('--force'), log });
}

try {
  main();
} catch (err) {
  console.error(`backup failed: ${err.message}`);
  process.exitCode = 1;
}
