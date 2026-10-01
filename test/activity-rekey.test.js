// A filer re-keying a position is not a trade. Real rows: T. Rowe Price Blue
// Chip Growth Fund's Canva holdings, 2022-09-30 (0001752724-22-267238) and
// 2022-12-31 (0000902259-23-000010; verified on EDGAR 2026-10-01: the new filing
// moves the old internal id into <cusip> and files a new "Internal ID", same
// share counts). Fields are the stored ones (issuer name filed as "N/A").
const test = require('node:test');
const assert = require('node:assert/strict');
const { diffPosition } = require('../lib/analytics/activity');

const row = (row_key, title, other_id, cusip, asset_cat, balance, value_usd) => ({
  row_key,
  issuer_name: null,
  title,
  other_id,
  cusip,
  asset_cat,
  balance,
  unit: 'NS',
  value_usd,
  instrument_type: 'equity',
  via_spv: 0,
  counts: true,
});
const sep = [
  row('80886808', 'CANVA SERIES A-4 CVT PFD STOCK PP', 'TC0C4GF51', '000000000', 'EP', 45, 42972.75),
  row('80887167', 'CANVA SERIES A CVT PFD STOCK PP', 'TC0R8VGD3', '000000000', 'EP', 3669, 3503711.55),
  row('80887122', 'CANVA SERIES A-5 CVT PFD STOCK PP', 'TC1ESFU48', '000000000', 'EP', 8, 7639.6),
  row('80887304', 'CANVA COMMON STOCK PP', 'TC1HS9QX6', '000000000', 'EC', 58155, 55535117.25),
  row('80887209', 'CANVA SERIES A-3 CVT PFD STOCK PP', 'TC89U35V4', '000000000', 'EP', 410, 391529.5),
];
const dec = [
  row('87126811', 'CANVA COMMON STOCK PP', '5654443', 'TC1HS9QX6', 'EC', 58155, 32089929.0),
  row('87126825', 'CANVA SERIES A CVT PFD STOCK PP', '6991464', 'TC0R8VGD3', 'EP', 3669, 2024554.2),
  row('87126831', 'CANVA SERIES A-4 CVT PFD STOCK PP', 'TC0C4GF51', '000000000', 'EP', 45, 24831.0),
  row('87126816', 'CANVA SERIES A-5 CVT PFD STOCK PP', 'TC1ESFU48', '000000000', 'EP', 8, 4414.4),
  row('87126781', 'CANVA SERIES A-3 CVT PFD STOCK PP', 'TC89U35V4', '000000000', 'EP', 410, 226238.0),
];

test('a re-keyed position is one continuing holding: no new class, no class dropped, all mark', () => {
  const ev = diffPosition(sep, dec);
  assert.equal(ev.type, 'unchanged');
  assert.equal(ev.instruments.length, 5);
  assert.ok(!ev.instruments.some(l => /new class|no longer/.test(l.change)));
  const common = ev.instruments.find(l => l.title === 'CANVA COMMON STOCK PP');
  assert.equal(common.rekeyedFrom, 'TC1HS9QX6');
  assert.equal(common.positionEffect, 0);
  assert.equal(common.markEffect.toFixed(2), (32089929.0 - 55535117.25).toFixed(2));
  const position = ev.instruments.reduce((s, l) => s + l.positionEffect, 0);
  assert.equal(position, 0);
});

test('a real exit still reads as one: an old key with no partner is "class no longer reported"', () => {
  const ev = diffPosition(
    sep,
    dec.filter(r => r.row_key !== '87126825')
  );
  const prefA = ev.instruments.find(l => l.instrumentKey === 'TC0R8VGD3');
  assert.equal(prefA.change, 'class no longer reported');
  assert.equal(ev.type, 'reduced');
});
