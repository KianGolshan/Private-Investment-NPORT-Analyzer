// Seed list for scripts/build-fund-index.js — fund/registrant names to
// resolve via EDGAR's company-name lookup (same lookupFundCiks() used by
// Fund X-Ray's manual search in server.js) as candidates for the "Top
// Funds" quick-select list.
//
// This is a starting point, not a verified list: it's compiled from
// well-known asset managers whose growth/growth-equity funds have been
// publicly reported (press coverage of marks on companies like SpaceX,
// OpenAI, Stripe, Databricks, etc.) to carry meaningful private-equity
// (Level 3 equity) exposure. Whether a name actually makes the final
// top-50 index is decided entirely by real EDGAR data in the build script
// — a candidate that doesn't resolve to a registrant, or whose recent
// filings show no qualifying private holdings, is simply dropped.
//
// EDGAR's company-name lookup matches on the REGISTRANT's own name, which
// for many fund families is a multi-series trust (e.g. "Franklin Strategic
// Series") rather than the marketing name of any one fund inside it (e.g.
// "Franklin DynaTech Fund") — so both specific fund names (for families
// registered as standalone entities) and broader trust/family names (for
// families organized as multi-series trusts) are included below. Feel free
// to add more of either kind and rerun `npm run build-fund-index`.
module.exports = [
  // American Funds / Capital Group
  'SmallCap World Fund',
  'Growth Fund of America',
  'New Perspective Fund',
  'New Economy Fund',
  'EuroPacific Growth Fund',
  'Capital World Growth and Income Fund',
  'International Growth and Income Fund',
  'American Funds Insurance Series',
  'Capital Group Global Growth Equity ETF',

  // Fidelity
  'Fidelity Contrafund',
  'Fidelity Blue Chip Growth Fund',
  'Fidelity OTC Portfolio',
  'Fidelity Growth Company Fund',
  'Fidelity Series Growth Company Fund',
  'Fidelity Advisor Growth Opportunities Fund',
  'Fidelity Mt Vernon Street Trust',
  'Fidelity Series Blue Chip Growth Fund',
  'Fidelity Securities Fund',
  'Fidelity Advisor Series I',
  'Fidelity Devonshire Trust',
  'Fidelity Select Portfolios',
  'Fidelity Magellan Fund',
  'Fidelity Puritan Trust',
  'Fidelity Concord Street Trust',

  // BlackRock
  'BlackRock Global Allocation Fund',
  'BlackRock Health Sciences Trust',
  'BlackRock Technology Opportunities Fund',
  'BlackRock Innovation and Growth Trust',
  'BlackRock Funds III',
  'BlackRock Large Cap Focus Growth Fund',
  'BlackRock Advantage Large Cap Growth Fund',
  'BlackRock Mid Cap Growth Equity Portfolio',

  // T. Rowe Price
  'T Rowe Price New Horizons Fund',
  'T Rowe Price Blue Chip Growth Fund',
  'T Rowe Price Growth Stock Fund',
  'T Rowe Price Institutional Large Cap Growth Fund',
  'T Rowe Price US Equity Research Fund',
  'T Rowe Price Global Technology Fund',
  'T Rowe Price Health Sciences Fund',
  'T Rowe Price Growth Stock Trust',
  'T Rowe Price Diversified Mid-Cap Growth Fund',
  'T Rowe Price Communications and Technology Fund',
  'T Rowe Price Science and Technology Fund',
  'T Rowe Price Mid-Cap Growth Fund',

  // Baillie Gifford
  'Baillie Gifford Funds',
  'Baillie Gifford US Equity Growth Fund',

  // Morgan Stanley (Counterpoint Global)
  'Morgan Stanley Institutional Fund',
  'Morgan Stanley Insight Fund',
  'Morgan Stanley Institutional Fund Trust',

  // Janus Henderson
  'Janus Investment Fund',
  'Janus Henderson',
  'Janus Aspen Series',

  // Neuberger Berman
  'Neuberger Berman Equity Funds',
  'Neuberger Berman Genesis Fund',

  // ClearBridge / Franklin / Legg Mason
  'Legg Mason Partners Equity Trust',
  'ClearBridge',
  'Franklin Strategic Series',
  'Franklin Growth Fund',
  'Franklin DynaTech Fund',
  'Franklin Growth Series',
  'Franklin Managed Trust',
  'Franklin Templeton Global Trust',

  // PGIM Jennison
  'PGIM Investment Funds',
  'PGIM Jennison',
  'Prudential Investment Portfolios',

  // Fred Alger
  'Alger Funds',
  'The Alger Funds',

  // Vanguard (actively managed, sub-advised)
  'Vanguard Explorer Fund',
  'Vanguard Chester Funds',
  'Vanguard World Fund',

  // Voya / Victory / William Blair / Artisan / Harbor / Hartford / Principal
  'Voya Investors Trust',
  'Victory Portfolios',
  'William Blair Funds',
  'Artisan Partners Funds',
  'Harbor Funds',
  'Hartford Series Fund Trust',
  'Hartford Growth Opportunities Fund',
  'Principal Funds',

  // Baron Capital — known for large, concentrated private-company stakes
  'Baron Partners Fund',
  'Baron Investment Funds Trust',
  'Baron Asset Fund',

  // ARK — explicitly designed to hold private/pre-IPO companies
  'ARK Venture Fund',

  // Other growth-oriented managers reported to hold pre-IPO stakes
  'Wellington Trust Company',
  'Putnam Funds Trust',
  'MFS Series Trust',
  'Invesco Growth Fund',
  'Columbia Funds Series Trust',
  'John Hancock Funds',
  'Brown Advisory Funds',
  'Polen Capital',
  'Wasatch Funds',
  'Grandeur Peak Funds',

  // Dimensional Fund Advisors
  'Dimensional Investment Group',
  'DFA Investment Dimensions Group',
  'Dimensional Emerging Markets Value Fund',
];
