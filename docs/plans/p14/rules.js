// Rule labels for the unreviewed queue (W2b deterministic triage). Rules are ordered; first match wins.
const fs = require('fs');
const { parse } = require(process.argv[2] + '/lib/entities/csv.js').parseCsv ? { parse: require(process.argv[2] + '/lib/entities/csv.js').parseCsv } : {};
const rows = parse(fs.readFileSync(process.argv[3], 'utf8'));
const FUNDWORD = /\b(FUND|FUNDS|L\.?P\.?|LP|PARTNERS|CAPITAL|VENTURES|FEEDER|OFFSHORE|ONSHORE|MASTER|CO-?INVEST\w*|CONTINUATION|PORTFOLIO|SERIES TRUST|SCSP|SCS|FCPI|FPCI|FCR|K\/S|GMBH & CO|AGGREGATOR|INVESTORS|OPPORTUNIT\w*|STRATEG\w*|SECONDAR\w*|EVERGREEN|TRUST|SICAV|SPV|HOLDINGS? L\.?P)\b/i;
const CURRENCY = /^(EURO|JAPANESE YEN|BRITISH POUND|POUND STERLING|SWISS FRANC|CANADIAN DOLLAR|AUSTRALIAN DOLLAR|HONG KONG DOLLAR|SINGAPORE DOLLAR|DANISH KRONE|SWEDISH KRONA|NORWEGIAN KRONE|NEW ZEALAND DOLLAR|US DOLLAR|U\.S\. DOLLAR|INDIAN RUPEE|KOREAN WON|CHINESE YUAN|BRAZILIAN REAL|MEXICAN PESO|SOUTH AFRICAN RAND|ISRAELI SHEKEL|[A-Z ]+ (DOLLAR|POUND|FRANC|KRONE|KRONA|RUPEE|PESO|YEN|YUAN|WON|REAL|RAND|ZLOTY|FORINT|LIRA|RINGGIT|BAHT|RUPIAH|DIRHAM|RIYAL))$/i;
const BULLION = /\b(GOLD BULLION|SILVER BULLION|PLATINUM BULLION|PALLADIUM BULLION|PHYSICAL GOLD|GOLD BARS?)\b/i;
const CLO = /\b(CLO|FUNDING LTD|LOAN FUND(ING)?|SENIOR LOAN|CDO)\b/i;
const out = [], review = [];
for (const r of rows) {
  const nm = r.nm.trim(), first = nm.split(',')[0];
  let t = null, why = '';
  if (!nm) { t = 'unclear'; why = 'no issuer name on the rows (trap 64)'; }
  else if (CURRENCY.test(first)) { t = 'cash_commodity'; why = 'currency holding'; }
  else if (BULLION.test(nm)) { t = 'cash_commodity'; why = 'bullion'; }
  else if (/RF/.test(r.itypes) && !/CORP/.test(r.itypes)) { t = 'registered_fund'; why = 'issuer type RF'; }
  else if (r.category === 'listed' && r.has_id === '1') { t = 'listed_security'; why = 'listing identifier (ISIN or ticker) in the listed group'; }
  else if (r.category === 'level12' && r.has_id === '1' && /CORP/.test(r.itypes)) { t = 'listed_security'; why = 'Level 1/2 with ISIN or ticker'; }
  else if (CLO.test(nm) && /\b(LTD|LIMITED)\b/i.test(nm)) { t = 'clo'; why = 'CLO name'; }
  else if (/PF/.test(r.itypes) || r.category === 'fund' || (r.category === 'level12' && FUNDWORD.test(nm))) { t = 'fund_interest'; why = r.category === 'fund' ? 'fund group' : 'issuer type PF or fund words'; }
  if (t) out.push([r.id, t, why, r.v]); else review.push(r);
}
const csv = s => /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
fs.writeFileSync(process.argv[4], 'entity_id,entity_type,rule,value_musd\n' + out.map(x => x.map(String).map(csv).join(',')).join('\n') + '\n');
fs.writeFileSync(process.argv[5], JSON.stringify(review));
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const by = {}; out.forEach(x => { by[x[1]] = by[x[1]] || [0, 0]; by[x[1]][0]++; by[x[1]][1] += +x[3]; });
console.log('rule-labeled', out.length, Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v[0] + ' / $' + (v[1] / 1000).toFixed(1) + 'B'])));
console.log('left for review', review.length, '$' + (sum(review, r => +r.v) / 1000).toFixed(2) + 'B', 'of which >= $1M:', review.filter(r => +r.v >= 1).length, '$' + (sum(review.filter(r => +r.v >= 1), r => +r.v) / 1000).toFixed(2) + 'B');
const bc = {}; review.filter(r => +r.v >= 1).forEach(r => bc[r.category] = (bc[r.category] || 0) + 1); console.log('review >= $1M by group', bc);
