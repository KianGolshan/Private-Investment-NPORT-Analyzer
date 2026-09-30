// Entity upkeep after any ingest (ROADMAP §Phase 4: "re-run after every
// ingest"): each fund's advisers from its latest N-CEN, then every holding
// row's company. Offline and idempotent.
const { refreshFundAdvisers } = require('./managers');
const { resolveCompanies } = require('./resolve');

function entityUpkeep(db) {
  const advisers = refreshFundAdvisers(db);
  const companies = resolveCompanies(db);
  return { advisers, companies };
}

module.exports = { entityUpkeep };
