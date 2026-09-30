/* global module */
// Fund X-Ray's "Top Funds" dropdown — a curated shortlist of well-known
// funds/fund-families, grouped by manager for easy browsing. Picking one
// just autofills the "Fund / Registrant Name" box and runs the exact same
// live search (searchFundXray() -> /api/search-fund -> /api/fund-xray)
// that typing a name and clicking Search already does — this is nothing
// more than a shortcut into that existing flow. There is no pre-computed
// data here (no CIKs, no $ figures): every selection is a fresh, live
// lookup against EDGAR, so it can never go stale the way a pre-built
// snapshot could.
//
// Every name below was resolved to a real EDGAR registrant with genuine
// Level-3-equity (private-company) holdings in its own recent NPORT-P
// filing, verified live while building this list — not a blind guess. A
// fund can still show little or no private exposure the next time you
// check it (holdings change every quarter), same as if you'd searched it
// manually — that's expected, not a bug. Add more names under any group
// (or a new group) any time; nothing else needs to change.
//
// Shared by the browser (app.js) and the entity seed (lib/entities/seed.js),
// which starts firm groupings from it.
(function (root) {
  const TOP_FUND_GROUPS = {
    'Capital Group (American Funds)': [
      'SmallCap World Fund',
      'Growth Fund of America',
      'New Economy Fund',
      'EuroPacific Growth Fund',
      'AMCAP Fund',
      'American Funds Insurance Series',
    ],
    // Several Fidelity funds share a legal registrant/trust name that isn't
    // the marketing name (e.g. "Fidelity Growth Company Fund" is a series
    // inside the registrant "Fidelity Mt Vernon Street Trust") — EDGAR's
    // company-name lookup only matches the REGISTRANT's own name, so these
    // use the verified registrant name instead of the fund's marketing name.
    Fidelity: [
      'Fidelity Contrafund',
      'Fidelity Mt Vernon Street Trust', // Fidelity Growth Company Fund
      'Fidelity Securities Fund', // Fidelity Small Cap Growth Fund
      'Fidelity Advisor Series I', // Fidelity Advisor Equity Growth Fund
      'Fidelity Advisor Series II', // Fidelity Advisor Strategic Income Fund
      'Fidelity Puritan Trust', // Fidelity Balanced Fund
      'Fidelity Advisor Series VII', // Fidelity Advisor Health Care Fund
      'Fidelity Central Investment Portfolios LLC', // Fidelity U.S. Equity Central Fund
      'Fidelity Hastings Street Trust', // Fidelity Growth Discovery Fund
      'Fidelity Trend Fund',
      'Fidelity Destiny Portfolios', // Fidelity Advisor Diversified Stock Fund
      'Fidelity Capital Trust', // Fidelity Capital Appreciation Fund
      'Fidelity Investment Trust', // Fidelity Worldwide Fund
      'Variable Insurance Products Fund',
    ],
    BlackRock: [
      'BlackRock Global Allocation Fund',
      'BlackRock Health Sciences Trust',
      'BlackRock Health Sciences Term Trust',
      'BlackRock Large Cap Focus Growth Fund',
      'BlackRock Science & Technology Trust',
      'BlackRock Science & Technology Term Trust',
      'BlackRock Technology & Private Equity Term Trust',
      'BlackRock Capital Appreciation Fund',
      'BlackRock Private Investments Fund',
      'BlackRock Large Cap Series Funds', // BlackRock Advantage Large Cap Core Fund
    ],
    'T. Rowe Price': [
      'T. Rowe Price Global Technology Fund',
      'T. Rowe Price All-Cap Opportunities Fund',
      'T. Rowe Price Blue Chip Growth Fund',
      'T. Rowe Price Science & Technology Fund',
      'T. Rowe Price Equity Funds', // T Rowe Price Large-Cap Growth Fund
      'T. Rowe Price Growth Stock Fund',
      'T. Rowe Price Communications & Technology Fund',
      'T. Rowe Price Global Allocation Fund',
      'T. Rowe Price Diversified Mid-Cap Growth Fund',
    ],
    // Alger's funds are split across several distinct registrants (no single
    // "Alger" umbrella trust) — each name below is one of those registrants.
    Alger: [
      'Alger Funds II', // Alger Spectra Fund
      'Alger Institutional Funds', // Alger Focus Equity Fund
      'Alger Funds', // Alger Mid Cap Focus Fund
    ],
    AllianceBernstein: [
      'AB Cap Fund', // AB Small Cap Growth Portfolio
      'AB Bond Fund', // AB Income Fund
    ],
    StepStone: ['StepStone Private Venture & Growth Fund', 'StepStone Private Markets'],
    'Stone Ridge': [
      'Stone Ridge Trust V', // Stone Ridge Alternative Lending Risk Premium Fund
      'Stone Ridge Trust II', // Stone Ridge Reinsurance Risk Premium Interval Fund
    ],
    'ARK Invest': ['ARK Venture Fund', 'ARK ETF Trust'], // ARK ETF Trust: ARK Next Generation Internet ETF
    'Franklin Templeton': [
      'Franklin Strategic Series', // Franklin Templeton SMACS Series E
      'Franklin Custodian Funds', // Franklin Growth Fund
    ],
    'Neuberger Berman': [
      'Neuberger Berman Alternative Funds', // Neuberger Long Short Fund
      'Neuberger Next Generation Connectivity Fund',
    ],
    SkyBridge: ['SkyBridge G II Fund', 'Skybridge Opportunity Fund'],
    Barings: ['Barings Corporate Investors', 'Barings Participation Investors'],
    'Columbia Threadneedle': ['Columbia Funds Variable Insurance Trust'], // Columbia Variable Portfolio - Strategic Income Fund
    'BNY Mellon': ['BNY Mellon Advantage Funds'], // BNY Mellon Technology Growth Fund
    'Baron Capital': ['Baron Asset Fund'],
    VanEck: ['VanEck ETF Trust'], // VanEck Junior Gold Miners ETF
    'Hartford Funds': [
      'Hartford Series Fund', // Hartford Small Company HLS Fund
      'Hartford Mutual Funds II', // Hartford Schroders International Multi-Cap Value Fund
    ],

    // Smaller/specialist managers, each with one real, verified holder
    Coatue: ['Coatue Innovative Strategies Fund'],
    'Destiny Capital': ['Destiny Tech100'],
    Fundrise: ['Fundrise Innovation Fund'],
    Robinhood: ['Robinhood Ventures Fund I'],
    Carlyle: ['Carlyle Tactical Private Credit Fund'],
    ERShares: ['EntrepreneurShares Series Trust'], // ERShares Private-Public Crossover ETF
    'New York Life Investments': ['NYLIM Funds'], // NYLI Winslow Large Cap Growth Fund
    Tema: ['Tema ETF Trust'], // Tema Space Innovators ETF
    'Morgan Stanley': ['Morgan Stanley Insight Fund'],
    'Artisan Partners': ['Artisan Partners Funds'], // Artisan International Fund
    USVC: ['USVC Venture Capital Access Fund'],
    Meridian: ['Meridian Fund'], // Meridian Growth Fund
    Nuveen: ['Nuveen Investment Trust II'], // Nuveen Winslow Large-Cap Growth ESG Fund
    'Wasatch Global Investors': ['Wasatch Funds Trust'], // Wasatch Small Cap Growth Fund
    'First Trust': ['First Trust Private Assets Fund'],
    Herzfeld: ['Herzfeld Caribbean Basin Fund'],
    'Jackson National': ['JNL Series Trust'], // JNL/PIMCO Income Fund
    'John Hancock': ['John Hancock Investment Trust'],
    'Dimensional Fund Advisors': ['Dimensional Emerging Markets Value Fund'],
    'The Private Shares Fund': ['Private Shares Fund'],
    Powerlaw: ['Powerlaw Corp'],
  };

  const api = { TOP_FUND_GROUPS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VantageFundGroups = api;
})(typeof window !== 'undefined' ? window : globalThis);
