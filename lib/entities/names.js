// Name helpers shared by the entity modules (seed, identity, resolve, report),
// so a raw name, an issuer key and the "bare security word" / "fund-like"
// rules mean the same thing everywhere.
const { issuerKeyOf } = require('../../parsers');

// Placeholder text filers put in name fields.
const NA = /^(N\/?A|NONE|NULL|NIL|-+)$/i;
const real = v => {
  const t = String(v ?? '').trim();
  return t && !NA.test(t) ? t : '';
};
// The raw name an 'exact' alias matches: issuer name, else title.
const rawName = r => (real(r.issuer_name) || real(r.title)).toUpperCase().replace(/\s+/g, ' ').trim();
// The issuer key (the seed's cluster and the identity graph's node).
const keyOf = r => issuerKeyOf({ issuer: r.issuer_name, title: r.title });
// Whole-word form for phrase matching: " ANTHROPIC PBC ".
const words = s =>
  ` ${String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()} `;

// Keys that are a bare security word ("Series A-5 Preferred" keys to "SERIES")
// name no company: never an anchor or a member. GENERIC_KEY (those plus 1-2
// character keys, too ambiguous) never takes an identity edge.
const GENERIC_WORD =
  /^(PREFERRED|PREFERENCE|CLASS|COMMON|EQUITY|UNITS?|SHARES?|STOCK|ORDINARY|SERIES|WARRANTS?|RIGHTS?|CVR|ESCROW|\d+)$/;
const GENERIC_KEY = new RegExp(`${GENERIC_WORD.source}|^[A-Z0-9]{1,2}$`);
// Fund interests and pooled vehicles by name (DATA-QUALITY trap 30).
const FUND_LIKE =
  /\b(FUND|FUNDS|PORTFOLIO|TRUST|MASTER|INDEX|LIFEPATH|FEEDER|CO ?INVEST\w*|L ?P|LLLP|PARTNERS|SPV|VEHICLE|SECONDARIES|VINTAGE|SCSP|SCA|SICAV|FCP)\b/;

module.exports = { NA, real, rawName, keyOf, words, GENERIC_WORD, GENERIC_KEY, FUND_LIKE };
