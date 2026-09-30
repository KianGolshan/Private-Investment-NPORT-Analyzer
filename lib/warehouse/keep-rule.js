// The ingest keep rule (ADR 0003), shared by the bulk and EDGAR paths:
// private-candidate holdings are equity-type rows (EC, EP, OTHER, and
// warrants) that are fair-value Level 3, restricted, or carry no
// check-digit-valid ISIN/CUSIP.
const { isValidCusip } = require('./identifiers');
const { classifyInstrument } = require('../../parsers');
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

// classifyInstrument() over stored fields: rebuilds what it reads from parsed
// XML. In the XML, category OTHER only exists as <assetConditional
// assetCat="OTHER" desc=…/>, which the bulk dataset (and the warehouse) keep
// as asset_cat OTHER + other_asset desc. Ingest uses it for instrument_type;
// the services for the class label and chart unit (DATA-QUALITY trap 40: a
// per-share chart only for share rows).
function classifyStored({ title, name, unit, assetCat, otherAsset, derivCat }, pricePerUnit = null) {
  const inv = { title, name, units: unit, assetCat: assetCat === 'OTHER' ? undefined : assetCat };
  if (assetCat === 'OTHER') inv.assetConditional = { assetCat: 'OTHER', desc: otherAsset || undefined };
  if (derivCat) inv.derivativeInfo = { optionsWaptionWarrantDeriv: { derivCat } };
  const c = classifyInstrument(inv, pricePerUnit, null);
  if (c.chartUnit === 'usd_per_share' && unit !== 'NS') c.chartUnit = 'usd_per_unit';
  return c;
}

module.exports = { isEquityType, isPrivateCandidate, classifyStored };
