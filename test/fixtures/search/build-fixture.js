#!/usr/bin/env node
// Rebuilds test/fixtures/search/ from the REAL warehouse.db (no network):
//
//   node test/fixtures/search/build-fixture.js [path/to/warehouse.db]
//
// Phase 5a search and routing cases (ROADMAP §5a Tests): Hockey Parent
// Holdings (brand "HUB INTL"), OpenAI with "OPEN AI GLOBAL" and BlackRock's
// "OpenAir.com" label (F32), FHU US Holdings / Chobani (F29), Pfizer (listed,
// F24), Vercel (unreviewed on 2026-09-30) and the Stripes PE funds (a
// look-alike of Stripe). Same export as the identity fixture: matching rows and
// every filing of their funds. The companies come from data/review/.
const { buildFixture } = require('../identity/build-fixture');
const { defaultWarehousePath } = require('../../../lib/warehouse/db');

buildFixture({
  src: process.argv[2] || defaultWarehousePath(),
  out: __dirname,
  names: [
    '\\bhockey parent\\b|\\bhub intl\\b',
    '\\bopen ?ai\\b|\\bopenair\\b',
    '\\bfhu ?u?s\\b|\\bchobani\\b',
    '\\bpfizer\\b',
    '\\bvercel\\b',
    '\\bstripes\\b',
  ],
  ids: [],
  leis: [],
});
