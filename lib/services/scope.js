// The analyst's scope (P6b): firm, fund, class and kind filters, the same on
// every company route and every analysis answer. One definition for stored
// rows (asof.companyRows `only`) and for position facts (their legs), so a
// filtered answer equals a post-filter of the unfiltered one.
//   firm   manager ids: the funds each firm advises (its book's funds:
//          firm.fundFirms, current N-CEN adviser; sub-advised funds excluded)
//   fund   fund keys
//   class  class labels as the class views group them (classes.classOfRow)
//   kind   direct | spv | fund | indirect (= spv or fund; asof.kindOf)
// Values within one filter are alternatives; filters combine.
const { rowInfo } = require('../analytics/asof');
const { classOfRow } = require('./classes');
const { fundFirms } = require('./firm');
const { ServiceError } = require('./errors');

const KINDS = { direct: ['direct'], spv: ['spv'], fund: ['fund'], indirect: ['spv', 'fund'] };
const list = v =>
  v == null || v === '' ? [] : (Array.isArray(v) ? v : String(v).split(',')).map(x => String(x).trim()).filter(Boolean);

// From query parameters (firm, fund, class, kind); validated.
function parseScope(query = {}) {
  const firm = list(query.firm).map(x => {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 1) throw new ServiceError(400, 'firm must be firm ids (positive integers)');
    return n;
  });
  const fund = list(query.fund).map(x => x.toUpperCase());
  const cls = list(query.class);
  const kind = list(query.kind).map(x => x.toLowerCase());
  for (const k of kind) if (!KINDS[k]) throw new ServiceError(400, 'kind must be direct, spv, fund or indirect');
  return { firm, fund, class: cls, kind };
}

const isEmpty = s => !s || (!s.firm?.length && !s.fund?.length && !s.class?.length && !s.kind?.length);
// Class and kind are properties of one company's securities: they need a company.
const needsSubject = s => !!(s && (s.class?.length || s.kind?.length));

// The funds in scope (a Set), or null for every fund.
function fundsInScope(db, scope) {
  if (!scope?.firm?.length && !scope?.fund?.length) return null;
  let funds = null;
  if (scope.firm?.length) {
    const { byFirm } = fundFirms(db);
    funds = new Set(scope.firm.flatMap(id => byFirm.get(id)?.managed || []));
  }
  if (scope.fund?.length) {
    const picked = new Set(scope.fund);
    funds = funds ? new Set([...funds].filter(k => picked.has(k))) : picked;
  }
  return funds;
}

// A class includes its segregated lines (trap 52): "Series I" matches "Series I
// (segregated)"; asking for the segregated label matches only those.
const classIn = (classes, label) => classes.has(label) || classes.has(String(label).replace(/ \(segregated\)$/, ''));

function matcher(db, scope) {
  const funds = fundsInScope(db, scope);
  const classes = scope?.class?.length ? new Set(scope.class) : null;
  const kinds = scope?.kind?.length ? new Set(scope.kind.flatMap(k => KINDS[k])) : null;
  return { funds, classes, kinds };
}

// A predicate over stored rows (with fund_key), or null for no filter.
function rowPredicate(db, scope) {
  if (isEmpty(scope)) return null;
  const { funds, classes, kinds } = matcher(db, scope);
  return r => {
    if (funds && !funds.has(r.fund_key)) return false;
    if (!classes && !kinds) return true;
    const p = rowInfo(r);
    return (!classes || classIn(classes, classOfRow(p))) && (!kinds || kinds.has(p.kind));
  };
}

// A predicate over position-fact legs, or null for no filter.
function legPredicate(db, scope) {
  if (isEmpty(scope)) return null;
  const { funds, classes, kinds } = matcher(db, scope);
  return l =>
    (!funds || funds.has(l.fund_key)) && (!classes || classIn(classes, l.class_label)) && (!kinds || kinds.has(l.kind));
}

// The scope as an answer states it.
const describe = scope =>
  isEmpty(scope) ? null : Object.fromEntries(Object.entries(scope).filter(([, v]) => v.length));

module.exports = { parseScope, rowPredicate, legPredicate, fundsInScope, isEmpty, needsSubject, describe, KINDS };
