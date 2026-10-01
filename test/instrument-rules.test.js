// Instrument rules after the post-P5 review, on real rows:
//   - trap 45: loans filed under assetConditional OTHER are debt, by the
//     filer's own wording; fund interests and CLO equity stay indirect;
//   - reclassifyStored moves stored rows and their filing totals exactly;
//   - trap 47: a title key carries EC/EP, so common and preferred filed under
//     one title with no id are two series (Nuveen Winslow, Anthropic).
const test = require('node:test');
const assert = require('node:assert');
const { classifyInstrument, instrumentKeyOf } = require('../parsers');
const { openWarehouse } = require('../lib/warehouse/db');
const { reclassifyStored } = require('../lib/warehouse/reclassify');
const { companyHistory } = require('../lib/analytics/asof');
const { goldenWarehouse } = require('./helpers/warehouseApp');

const other = (desc, units = 'PA') => ({ units, assetConditional: { assetCat: 'OTHER', desc } });

test('trap 45: OTHER rows the filer describes as loans are debt; fund interests and CLO equity stay indirect', () => {
  // Blue Owl Alternative Credit Fund, 0001410368-26-089935 (2026-06-30).
  for (const desc of ['MCA-1', 'MCA', 'HEI', 'Personal Loans', 'Promissory Note', 'Senior Debt', 'CLO Debt'])
    assert.strictEqual(classifyInstrument(other(desc), 0.9665, 4573.9).instrumentType, 'debt', desc);
  assert.strictEqual(classifyInstrument(other('MCA-1'), 0.9665).chartUnit, 'pct_of_par');
  for (const desc of [
    'Private Fund',
    'CLO Equity',
    'Collateralized Loan Obligations-Subordinated residual tranche securities',
    'Private Debt Investments', // interests in private debt funds (BII BID Aggregator A L.P.)
  ])
    assert.strictEqual(classifyInstrument(other(desc), 1).instrumentType, 'indirect', desc);
  assert.strictEqual(classifyInstrument(other('Funding Agreement', 'NS'), 1).chartUnit, 'usd_per_unit');
});

test('reclassifyStored: real Blue Owl rows move to debt with their filing totals; a second run changes nothing', () => {
  const db = openWarehouse(':memory:');
  const acc = '0001410368-26-089935';
  db.prepare(
    `INSERT INTO filings (accession, fund_key, cik, series_name, report_date, filing_date, form, source)
     VALUES (?, 'S000071906', '1810747', 'Blue Owl Alternative Credit Fund', '2026-06-30', '2026-08-28', 'NPORT-P', 'edgar')`
  ).run(acc);
  const put = db.prepare(
    `INSERT INTO holdings (accession, row_key, issuer_name, title, balance, unit, value_usd, asset_cat, other_asset,
       fv_level, instrument_type) VALUES (@accession, @row_key, @t, @t, @balance, @unit, @value, 'OTHER', @oa, '3', 'indirect')`
  );
  const rows = [
    { row_key: 'doc:100', t: '10014233', balance: 4731.99, unit: 'PA', value: 4573.89762024, oa: 'MCA-1' },
    { row_key: 'doc:16175', t: '2023062-TOLUK', balance: 175000, unit: 'PA', value: 218354.72784988, oa: 'HEI' },
    { row_key: 'doc:20015', t: '47494351', balance: 21309.19, unit: 'PA', value: 3725.91929275, oa: 'Personal Loans' },
    // CIFC Funding 2014-III (0000894189-26-016078's row, kept here for the rule): CLO equity stays.
    {
      row_key: 'doc:9',
      t: 'CIFC 2014-3A SUB 03/31/2038',
      balance: 22386000,
      unit: 'PA',
      value: 9849840,
      oa: 'CLO Equity',
    },
  ];
  for (const r of rows) put.run({ accession: acc, ...r });
  const total = rows.reduce((s, r) => s + r.value, 0);
  db.prepare(
    `INSERT INTO filing_totals (accession, rows, value_usd, rows_listed, value_listed, rows_debt, value_debt,
       rows_l3_equity, value_l3_equity) VALUES (?, 4, ?, 0, 0, 0, 0, 4, ?)`
  ).run(acc, total, total);

  const s = reclassifyStored(db);
  assert.strictEqual(s.toDebt, 3);
  const types = db.prepare('SELECT row_key, instrument_type FROM holdings ORDER BY row_key').all();
  assert.deepStrictEqual(Object.fromEntries(types.map(r => [r.row_key, r.instrument_type])), {
    'doc:100': 'debt',
    'doc:16175': 'debt',
    'doc:20015': 'debt',
    'doc:9': 'indirect',
  });
  const t = db.prepare('SELECT * FROM filing_totals').get();
  assert.strictEqual(t.rows_debt, 3);
  assert.strictEqual(t.rows_l3_equity, 1);
  assert.ok(Math.abs(t.value_debt - (4573.89762024 + 218354.72784988 + 3725.91929275)) < 1e-6);
  assert.ok(Math.abs(t.value_l3_equity - 9849840) < 1e-3);
  assert.deepStrictEqual(reclassifyStored(db), { checked: 4, toDebt: 0, fromDebt: 0, other: 0, valueToDebt: 0 });
});

test('trap 47: common and preferred under one title are two instruments', () => {
  assert.notStrictEqual(
    instrumentKeyOf({ title: 'Anthropic PBC', assetCat: 'EC' }),
    instrumentKeyOf({ title: 'Anthropic PBC', assetCat: 'EP' })
  );
  // The filer's id still decides when present; OTHER rows keep the plain title.
  assert.strictEqual(instrumentKeyOf({ otherId: 'X1', title: 'T', assetCat: 'EP' }), 'X1');
  assert.strictEqual(instrumentKeyOf({ title: 'T', assetCat: 'OTHER' }), 'T');

  // Nuveen Winslow Large-Cap Growth ESG Fund: 8,918 common and 9,363 preferred
  // Anthropic shares, both titled "Anthropic PBC", no ids (0001041673-26-000094).
  const { db, idOf } = goldenWarehouse();
  const nuveen = companyHistory(db, { companyId: idOf('Anthropic') }).find(f =>
    /Nuveen Winslow Large-Cap Growth ESG/.test(f.seriesName || '')
  );
  assert.ok(nuveen, 'Nuveen Winslow is in the golden fixture');
  for (const s of nuveen.series) {
    const dates = s.points.map(p => p.markDate);
    assert.strictEqual(new Set(dates).size, dates.length, `${s.instrumentKey}: one point per date`);
  }
  const balances = nuveen.series.map(s => s.points[s.points.length - 1].balance).sort((a, b) => a - b);
  assert.deepStrictEqual(balances.slice(-2), [8918, 9363]);
});
