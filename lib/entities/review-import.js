// The review import (npm run review:aliases), shared by the script and the
// admin "make this a company" job (lib/entities/make-company.js): the reviewed
// files, then company resolution, fund advisers, the identity graph, unreviewed
// entities and the search index. company_ids.csv is written back after the
// alias import (new ids, retired ids with redirects). Missing files are skipped;
// any invalid row aborts with the file and line.
const fs = require('fs');
const path = require('path');
const { parseCsv, toCsv } = require('./csv');
const {
  importAliases,
  importManagers,
  importDisclosedExposure,
  companyIdRows,
  COMPANY_ID_COLUMNS,
  managerIdRows,
  MANAGER_ID_COLUMNS,
} = require('./review');
const { entityUpkeep } = require('./upkeep');
const { identityUpkeep } = require('./report');
const { rebuildEntities } = require('./entities');
const { buildPositionFacts } = require('../warehouse/position-facts');

function runReviewImport(db, dir, { log = () => {}, now } = {}) {
  const read = f => {
    const p = path.join(dir, f);
    return fs.existsSync(p) ? parseCsv(fs.readFileSync(p, 'utf8')) : null;
  };
  const out = {};
  const aliases = read('aliases.csv');
  if (aliases) {
    out.aliases = importAliases(db, aliases, { ids: read('company_ids.csv'), ...(now ? { now } : {}) });
    log('aliases:', out.aliases);
    fs.writeFileSync(path.join(dir, 'company_ids.csv'), toCsv(COMPANY_ID_COLUMNS, companyIdRows(db)));
  }
  const managers = read('managers.csv');
  if (managers) {
    out.managers = importManagers(db, managers, { ids: read('manager_ids.csv') });
    log('managers:', out.managers);
    fs.writeFileSync(path.join(dir, 'manager_ids.csv'), toCsv(MANAGER_ID_COLUMNS, managerIdRows(db)));
  }
  const disclosed = read('disclosed_exposure.csv');
  if (disclosed) log('disclosed exposure:', (out.disclosed = importDisclosedExposure(db, disclosed)));
  const e = entityUpkeep(db);
  log('fund advisers:', (out.advisers = e.advisers));
  log('holdings resolved:', (out.companies = e.companies));
  log('unreviewed entities and search:', (out.entities = rebuildEntities(db, identityUpkeep(db))));
  // Which rows are private companies just changed: the position facts follow.
  log('position facts:', (out.positionFacts = buildPositionFacts(db)));
  return out;
}

module.exports = { runReviewImport };
