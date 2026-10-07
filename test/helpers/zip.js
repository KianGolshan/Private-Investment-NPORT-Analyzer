// Test-only zip reader/writer for editing real fixture archives: readZip
// returns { name: Buffer } (through yauzl, like the ingest), writeZip stores
// files uncompressed. Used to put schema drift into a real N-CEN data set.
const zlib = require('node:zlib');
const yauzl = require('yauzl');

function readZip(buf) {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const files = {};
      zip.on('entry', entry =>
        zip.openReadStream(entry, (e, s) => {
          if (e) return reject(e);
          const parts = [];
          s.on('data', d => parts.push(d));
          s.on('end', () => {
            files[entry.fileName] = Buffer.concat(parts);
            zip.readEntry();
          });
        })
      );
      zip.on('end', () => resolve(files));
      zip.on('error', reject);
      zip.readEntry();
    })
  );
}

function writeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

module.exports = { readZip, writeZip };
