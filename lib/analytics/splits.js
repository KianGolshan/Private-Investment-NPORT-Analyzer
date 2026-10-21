// Stock-split detection shared by the parsers (parsers.js) and the warehouse
// analytics (asof.js, activity.js). NPORT-P reports units and a fair value, never corporate actions,
// so a split shows up as units jumping by a clean ratio while the price falls
// by about the same ratio. Without this, a 5-for-1 split reads as a huge
// purchase (and a ~68% markdown) in returns, comparisons and velocity.
//
// Real cases this was built against: SpaceX SPV positions at Destiny Tech100
// (135,135 → 675,675 units, $529 → $171) and Private Shares Fund (10×,
// $1,000-ish → $100, value unchanged to the dollar).
const SPLIT_RATIOS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 50, 100];
const UNIT_TOLERANCE = 0.005;
// Units restated (DATA-QUALITY trap 63): a filer restates a holding in other
// units at the same value. PGIM High Yield's Ferrellgas escrow preferred went from
// 135,375 to 135,375,000 shares at $135,375,000 both times, same filer id
// (0001752724-21-157139 → 0001752724-21-224848). No trade multiplies shares 10×
// at a flat value, so the exact ratio restates the prior side like a split.
const RESTATED_MIN_RATIO = 10;
const RESTATED_VALUE_TOLERANCE = 0.01;
// Units restated with a re-mark (P14, trap 63): units move 50x or more while the
// value stays in a re-mark band. Partners Group Growth reported Impilo Orphan Drugs
// as 0.04 shares ($122,320.31, 0001410368-26-021560) then 88,174.80 shares
// ($224,435.86, 0001410368-26-056536); Partners Group funds flip between units and
// thousands of units (EnfraGen 37,786 -> 35,172,405.56). Buying 50x the shares
// would multiply the value too, so the prior side is restated: the change is mark.
const RESTATED_REMARK_MIN_RATIO = 50;
const RESTATED_REMARK_BAND = [0.25, 4];

// prev/cur: { shares, pricePerShare }. Returns the split ratio applied going
// prev → cur (5 = 5-for-1 forward split, 0.1 = 1-for-10 reverse), or null.
// opts.remark: also read units restated with a re-mark (one security across two
// filings, activity.leg); a class moving between keys keeps the stricter rules
// (a 60:1 exchange under a new key stays apart, activity.mergeClassMoves).
// A split must (a) change units by a clean ratio, (b) move price the
// opposite way, and (c) leave total value within a plausible re-mark band —
// otherwise it's a purchase, sale, or re-mark that merely looks round.
function detectSplit(prev, cur, { remark = false } = {}) {
  if (!prev || !cur) return null;
  const ps = prev.shares;
  const cs = cur.shares;
  const pp = prev.pricePerShare;
  const cp = cur.pricePerShare;
  if (!(ps > 0 && cs > 0 && pp > 0 && cp > 0)) return null;
  const r = cs / ps;
  const q = cp / pp;
  const valueRatio = r * q;
  for (const k of SPLIT_RATIOS) {
    const band = k === 2 ? [0.75, 1.35] : [0.25, 4];
    if (Math.abs(r / k - 1) <= UNIT_TOLERANCE && q <= 0.85 && valueRatio >= band[0] && valueRatio <= band[1]) return k;
    if (Math.abs(r * k - 1) <= UNIT_TOLERANCE && q >= 1.15 && valueRatio >= band[0] && valueRatio <= band[1])
      return 1 / k;
  }
  if ((r >= RESTATED_MIN_RATIO || r <= 1 / RESTATED_MIN_RATIO) && Math.abs(valueRatio - 1) <= RESTATED_VALUE_TOLERANCE)
    return r;
  if (
    remark &&
    (r >= RESTATED_REMARK_MIN_RATIO || r <= 1 / RESTATED_REMARK_MIN_RATIO) &&
    valueRatio >= RESTATED_REMARK_BAND[0] &&
    valueRatio <= RESTATED_REMARK_BAND[1]
  )
    return r;
  return null;
}

module.exports = { detectSplit, SPLIT_RATIOS };
