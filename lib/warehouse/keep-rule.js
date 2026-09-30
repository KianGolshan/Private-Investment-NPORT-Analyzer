// The ingest keep rule (ADR 0003), shared by the bulk and EDGAR paths:
// private-candidate holdings are equity-type rows (EC, EP, OTHER, and
// warrants) that are fair-value Level 3, restricted, or carry no
// check-digit-valid ISIN/CUSIP.
const { isValidCusip } = require('./identifiers');
const { num } = require('./values');

function isEquityType(row) {
  const deriv = String(row.DERIVATIVE_CAT || '').trim();
  if (deriv) return deriv === 'WAR';
  return row.ASSET_CAT === 'EC' || row.ASSET_CAT === 'EP' || row.ASSET_CAT === 'OTHER';
}

function isPrivateCandidate(row, hasValidIsin) {
  if (!isEquityType(row)) return false;
  // Same placeholder rule as extractAllHoldings: a row with neither a balance
  // nor a value carries nothing (real: Destiny Tech100 reports "Rhenium Bolt
  // 2021, LLC" with <balance>N/A</balance> and valUSD 0).
  if (!num(row.BALANCE) && !num(row.CURRENCY_VALUE)) return false;
  if (String(row.FAIR_VALUE_LEVEL).trim() === '3') return true;
  if (String(row.IS_RESTRICTED_SECURITY).trim().toUpperCase() === 'Y') return true;
  return !hasValidIsin && !isValidCusip(row.ISSUER_CUSIP);
}

module.exports = { isEquityType, isPrivateCandidate };
