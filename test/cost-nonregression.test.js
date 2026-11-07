// P15 non-regression (ADR 0011, plan §9): the cost work may only ADD fields to existing
// answers. scripts/snapshot-api.js records every answer for Anthropic, Databricks and
// Anduril (and every fund and firm that held them) and diffs two generations; these
// tests pin the diff rule itself, so the gate cannot pass a real change.
//
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { compare, stable, ALLOWED_ADDED } = require('../scripts/snapshot-api');

const before = {
  refreshId: 69,
  generation: { id: 69 },
  rows: [
    { fundKey: 'S000007119', shares: 235150, value: 146484341, cls: 'Series D' },
    { fundKey: 'S000009228', shares: 2859590, value: 741023858.08, cls: 'Class F-1' },
  ],
  total: 887508199.08,
};

test('only the generation fields are dropped; every other field is compared', () => {
  assert.deepEqual(Object.keys(stable(before)), ['rows', 'total']);
  assert.deepEqual(stable({ a: [{ job: 1, b: 2 }] }), { a: [{ b: 2 }] });
});

test('allowed additions pass; nothing else may change', () => {
  const same = stable(structuredClone(before));
  assert.deepEqual(compare(stable(before), same), []);
  // added cost fields are allowed, at any depth
  const added = structuredClone(same);
  added.rows[0].cost = { usd: 7055558, accession: '0000707823-26-000042' };
  added.costCoverage = 0.5;
  assert.deepEqual(compare(stable(before), added), []);
  for (const k of ['cost', 'costCoverage', 'roundPrices', 'ncsrFilings', 'acquired']) assert.ok(ALLOWED_ADDED.has(k));

  const changed = structuredClone(same);
  changed.rows[1].shares = 2859591; // one share
  assert.equal(compare(stable(before), changed)[0][0], '.rows[1].shares');

  const value = structuredClone(same);
  value.total += 0.01; // one cent
  assert.equal(compare(stable(before), value).length, 1);

  const missing = structuredClone(same);
  delete missing.rows[0].cls;
  assert.equal(compare(stable(before), missing)[0][1], 'Series D');

  const extra = structuredClone(same);
  extra.rows[0].price = 622.94; // a new field outside the allowed list
  assert.equal(compare(stable(before), extra)[0][0], '.rows[0].price');

  const reordered = structuredClone(same);
  reordered.rows.reverse(); // a ranking changed
  assert.ok(compare(stable(before), reordered).length > 0);

  const shorter = structuredClone(same);
  shorter.rows.pop();
  assert.equal(compare(stable(before), shorter)[0][0], '.rows');

  const keys = { total: same.total, rows: same.rows }; // same values, columns in another order
  assert.equal(compare(stable(before), keys)[0][0], ' (key order)');
});
