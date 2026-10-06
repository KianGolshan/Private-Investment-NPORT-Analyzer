// The golden fixture (test/fixtures/warehouse/, real rows) with the committed
// data/review/ files imported (companies, managers), fund advisers, entities
// rebuilt and one ok refresh run: what
// the warehouse routes (lib/api/warehouse.js) serve in the offline tests.
const fs = require('fs');
const path = require('path');
const express = require('express');
const { importAliases, importDisclosedExposure, importManagers } = require('../../lib/entities/review');
const { refreshFundAdvisers } = require('../../lib/entities/managers');
const { rebuildFundNames } = require('../../lib/warehouse/fund-names');
const { buildPositionFacts } = require('../../lib/warehouse/position-facts');
const { resolveCompanies } = require('../../lib/entities/resolve');
const { parseCsv } = require('../../lib/entities/csv');
const { identityUpkeep } = require('../../lib/entities/report');
const { rebuildEntities } = require('../../lib/entities/entities');
const { warehouseRouter } = require('../../lib/api/warehouse');
const { openFixtureWarehouse } = require('./warehouseFixture');

const REVIEW = path.join(__dirname, '..', '..', 'data', 'review');
const readReview = f => parseCsv(fs.readFileSync(path.join(REVIEW, f), 'utf8'));

function goldenWarehouse() {
  const { db } = openFixtureWarehouse();
  importAliases(db, readReview('aliases.csv'), { ids: readReview('company_ids.csv'), now: '2026-09-30T00:00:00Z' });
  importDisclosedExposure(db, readReview('disclosed_exposure.csv'));
  // firms from the committed ledger (manager_ids.csv), as the review import
  // builds them; the fixture's exported managers table is an older snapshot
  db.exec('DELETE FROM manager_advisers; DELETE FROM manager_registrants; DELETE FROM managers');
  importManagers(db, readReview('managers.csv'), { ids: readReview('manager_ids.csv') });
  refreshFundAdvisers(db);
  resolveCompanies(db);
  rebuildEntities(db, identityUpkeep(db));
  rebuildFundNames(db);
  buildPositionFacts(db);
  db.prepare(
    "INSERT INTO refresh_runs (started_at, finished_at, status) VALUES ('2026-09-30T00:00:00Z', '2026-09-30T00:01:00Z', 'ok')"
  ).run();
  const app = express();
  app.use(
    '/api',
    warehouseRouter(() => db)
  );
  const idOf = name => db.prepare('SELECT id FROM companies WHERE name = ?').get(name).id;
  const firmIdOf = name => db.prepare('SELECT id FROM managers WHERE name = ?').get(name).id;
  return { db, app, idOf, firmIdOf };
}

module.exports = { goldenWarehouse, readReview };
