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

// Trap 51, relabeled too: Coatue Innovative Strategies Fund's 433,333 Databricks
// units ($82,333,270) under three ids and labels (verified on EDGAR 2026-10-01:
// 0001410368-26-016645, -061868, -085820).
const unit = (row_key, title, issuer_name, other_id, balance, value_usd) => ({
  row_key,
  issuer_name,
  title,
  other_id,
  cusip: '000000000',
  asset_cat: 'OTHER',
  balance,
  unit: 'OU',
  value_usd,
  instrument_type: 'indirect',
  via_spv: 0,
  counts: true,
});
const seriesL = r =>
  unit(r, 'DATABRICKS SERIES L PREFERRED', 'DATABRICKS SERIES L PREFERRED', '957EGC901', 789473, 149999870);

test('a re-key that also relabels the class pairs when units, shares and value carry over (Coatue)', () => {
  const dec25 = [seriesL('1'), unit('2', 'DATABRICKS, INC.', 'DATABRICKS, INC.', '990AASZB6', 433333, 82333270)];
  const mar26 = [
    seriesL('3'),
    unit('4', 'DATABRICKS INC. - SERIES K PREFERRED', 'Databricks, Inc.', 'EQT_268664', 433333, 82333270),
  ];
  const jun26 = [seriesL('5'), unit('6', 'DATABRICKS INC. - SERIES K PREFERRED', null, 'INTERNAL1', 433333, 82333270)];
  for (const [a, b, from] of [
    [dec25, mar26, '990AASZB6'],
    [mar26, jun26, 'EQT_268664'],
  ]) {
    const ev = diffPosition(a, b);
    assert.equal(ev.type, 'unchanged');
    assert.equal(ev.instruments.length, 2);
    assert.equal(ev.instruments.find(l => l.rekeyedFrom).rekeyedFrom, from);
    assert.ok(ev.instruments.every(l => l.positionEffect === 0 && l.markEffect === 0));
  }
  // A different value is not the same holding: it stays a class change.
  const sold = [seriesL('7'), unit('8', 'DATABRICKS INC. - SERIES K PREFERRED', null, 'INTERNAL1', 433333, 70000000)];
  assert.equal(diffPosition(mar26, sold).type, 'mixed');
});

// Trap 52: Fidelity Select Technology Portfolio moved Databricks Series H-K into
// "PC PP-SEGREGATED LINE" rows (0000035402-26-002676 -> 0000035402-26-004764,
// verified on EDGAR 2026-10-01): every class kept its shares, the mark went
// $179.70 -> $190.00. One mark move of 493,279 sh x $10.30, no position change.
const fid = (row_key, title, other_id, balance, value_usd) => ({
  row_key,
  issuer_name: 'DATABRICKS INC',
  title,
  other_id,
  cusip: '000000000',
  asset_cat: 'EP',
  balance,
  unit: 'NS',
  value_usd,
  instrument_type: 'equity',
  via_spv: 0,
  counts: true,
});
const feb = [
  fid('1', 'DATABRICKS INC SER G PC PP', 'HBE119000', 82812, 14881316.4),
  fid('2', 'DATABRICKS INC SER H PC PP', 'IAD780000', 273804, 49202578.8),
  fid('3', 'DATABRICKS INC SER I PC PP', 'JYA752000', 4234, 760849.8),
  fid('4', 'DATABRICKS INC SER J PC PP', 'KWH825000', 130729, 23492001.3),
  fid('5', 'DATABRICKS INC SER K PC PP', 'LOU862000', 1700, 305490.0),
];
const may = [
  fid('6', 'DATABRICKS INC SER I PC PP-SEGREGATED LINE', 'MML448000', 4234, 804460.0),
  fid('7', 'DATABRICKS INC SER H PC PP', 'IAD780000', 157694, 29961860.0),
  fid('8', 'DATABRICKS INC SER K PC PP-SEGREGATED LINE', 'MML454000', 1700, 323000.0),
  fid('9', 'DATABRICKS INC SER H PC PP-SEGREGATED LINE', 'MML443000', 116110, 22060900.0),
  fid('10', 'DATABRICKS INC SER G PC PP', 'HBE119000', 82812, 15734280.0),
  fid('11', 'DATABRICKS INC SER J PC PP-SEGREGATED LINE', 'MML451000', 130729, 24838510.0),
];

test('a class moved to segregated lines is one position per class: all mark, no position (trap 52)', () => {
  const ev = diffPosition(feb, may);
  assert.equal(ev.type, 'unchanged');
  assert.equal(ev.instruments.length, 5);
  const h = ev.instruments.find(l => l.instrumentKey === 'IAD780000');
  assert.deepEqual([h.prevBalance, h.balance, h.mergedKeys], [273804, 273804, ['MML443000']]);
  assert.equal(ev.instruments.find(l => l.instrumentKey === 'MML448000').mergedKeys[0], 'JYA752000');
  const sum = k => ev.instruments.reduce((s, l) => s + l[k], 0);
  assert.equal(Math.round(sum('positionEffect') * 100), 0);
  assert.equal(sum('markEffect').toFixed(2), '5080773.70');
  assert.equal((sum('value') - sum('prevValue')).toFixed(2), '5080773.70');
});

test('a class move is merged only when it is one security: a 60:1 exchange and a relabeled key stay per key', () => {
  // Nscale Series B 17,700 sh at $1,290.35 -> 1,062,000 sh at $20.39 under a new
  // issuer name (2026-05-31): beyond a 4x mark move, the keys stay apart.
  const before = [fid('1', 'NSCALE GLOBAL HOLDINGS LTD SER B PC PP', 'LRC136000', 17700, 22839195)];
  const after = [fid('2', 'NSCALE LIMITED SER B PC PP', 'MMJ769000', 1062000, 21654180)];
  const ev = diffPosition(before, after);
  assert.equal(ev.type, 'mixed');
  assert.ok(!ev.instruments.some(l => l.mergedKeys));
  assert.equal(Math.round(ev.instruments.reduce((s, l) => s + l.positionEffect, 0)), 21654180 - 22839195);
  // Redwood Materials' key 8900108 is in both filings, relabeled Series C -> D
  // at the same $47.74 (2023-12-31): neither class merges.
  const c = (k, t, b) => ({ ...fid(k, t, k, b, b * 47.74), issuer_name: 'REDWOOD MATERIALS' });
  const ev2 = diffPosition(
    [
      c('6382450', 'REDWOOD MATERIALS SER C CVT STOCK PP', 1538629),
      c('8900108', 'REDWOOD MATERIALS INC PP SER C CVT PFD', 1065590),
    ],
    [
      c('6382450', 'REDWOOD MATERIALS SER C CVT STOCK PP', 1538629),
      c('8900108', 'REDWOOD MATERIALS INC PP SER D CVT PFD', 1065590),
    ]
  );
  assert.equal(ev2.type, 'unchanged');
  assert.ok(ev2.instruments.every(l => !l.mergedKeys && l.positionEffect === 0));
});

// Staff review F05 (2026-10-05): a class written down to $0 while another class
// stays positive is a mark move, not a class no longer reported. Expected values
// are worked by hand, not by leg(): Common A 195,705 sh at $154.15 = $30,167,925.75
// (reported at $0 next filing, same shares); Series B 1,000 sh $10.00 -> $12.00.
const zrow = (key, title, balance, value_usd) => ({
  ...row(key, title, key, '000000000', 'EC', balance, value_usd),
  counts: value_usd > 0,
});
const before = [zrow('A1', 'X CORP COMMON A', 195705, 30167925.75), zrow('B1', 'X CORP SERIES B PFD', 1000, 10000)];
const zeroed = [zrow('A1', 'X CORP COMMON A', 195705, 0), zrow('B1', 'X CORP SERIES B PFD', 1000, 12000)];

test('F05: one class reported at $0 beside a positive class is a mark move with its shares kept', () => {
  const ev = diffPosition(before, zeroed);
  const a = ev.instruments.find(l => l.instrumentKey === 'A1');
  assert.equal(a.change, 'reported at $0');
  assert.equal(a.balance, 195705);
  assert.equal(a.value, 0);
  assert.equal(a.positionEffect, 0);
  assert.equal(a.markEffect.toFixed(2), '-30167925.75');
  const pos = ev.instruments.reduce((s, l) => s + l.positionEffect, 0);
  const mark = ev.instruments.reduce((s, l) => s + l.markEffect, 0);
  assert.equal(pos, 0);
  assert.equal(mark.toFixed(2), (-30167925.75 + 2000).toFixed(2));
  assert.equal(ev.type, 'unchanged'); // no shares moved: the event is a mark move
});

test('F05: a partial sale plus a write-down splits into position (prior mark) and mark', () => {
  // 195,705 -> 100,000 sh: position = -95,705 x $154.15 = -14,752,925.75; mark = 100,000 x -$154.15 = -15,415,000
  const ev = diffPosition(before, [zrow('A1', 'X CORP COMMON A', 100000, 0), before[1]]);
  const a = ev.instruments.find(l => l.instrumentKey === 'A1');
  assert.equal(a.change, 'reported at $0');
  assert.equal(a.positionEffect.toFixed(2), '-14752925.75');
  assert.equal(a.markEffect.toFixed(2), '-15415000.00');
  assert.equal(ev.type, 'reduced');
});

test('F05: the whole position at $0 keeps its shares; recovery from $0 is a mark move, not first reported', () => {
  const allZero = [zrow('A1', 'X CORP COMMON A', 195705, 0), zrow('B1', 'X CORP SERIES B PFD', 1000, 0)];
  const z = diffPosition(before, allZero);
  assert.equal(z.type, 'zeroed');
  assert.deepEqual(
    z.instruments.map(l => [l.instrumentKey, l.balance, l.positionEffect, l.markEffect.toFixed(2)]),
    [
      ['A1', 195705, 0, '-30167925.75'],
      ['B1', 1000, 0, '-10000.00'],
    ]
  );
  // back above $0 at 1,000 sh x $5: all mark (+$5,000), nothing "first reported"
  const back = diffPosition(allZero, [
    zrow('A1', 'X CORP COMMON A', 195705, 0),
    zrow('B1', 'X CORP SERIES B PFD', 1000, 5000),
  ]);
  assert.notEqual(back.type, 'new');
  const b = back.instruments.find(l => l.instrumentKey === 'B1');
  assert.equal(b.positionEffect, 0);
  assert.equal(b.markEffect, 5000);
  assert.equal(b.change, 'reported above $0 again');
  // a class still at $0 on both sides is not a leg
  assert.ok(!back.instruments.some(l => l.instrumentKey === 'A1'));
});
