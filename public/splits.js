/* global module */
// Stock-split detection shared by the server (parsers.js) and the browser
// (app.js). NPORT-P reports units and a fair value, never corporate actions,
// so a split shows up as units jumping by a clean ratio while the price falls
// by about the same ratio. Without this, a 5-for-1 split reads as a huge
// purchase (and a ~68% markdown) in returns, comparisons and velocity.
//
// Real cases this was built against: SpaceX SPV positions at Destiny Tech100
// (135,135 → 675,675 units, $529 → $171) and Private Shares Fund (10×,
// $1,000-ish → $100, value unchanged to the dollar).
(function (root) {
  const SPLIT_RATIOS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 50, 100];
  const UNIT_TOLERANCE = 0.005;

  // prev/cur: { shares, pricePerShare }. Returns the split ratio applied going
  // prev → cur (5 = 5-for-1 forward split, 0.1 = 1-for-10 reverse), or null.
  // A split must (a) change units by a clean ratio, (b) move price the
  // opposite way, and (c) leave total value within a plausible re-mark band —
  // otherwise it's a purchase, sale, or re-mark that merely looks round.
  function detectSplit(prev, cur) {
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
      if (Math.abs(r / k - 1) <= UNIT_TOLERANCE && q <= 0.85 && valueRatio >= band[0] && valueRatio <= band[1])
        return k;
      if (Math.abs(r * k - 1) <= UNIT_TOLERANCE && q >= 1.15 && valueRatio >= band[0] && valueRatio <= band[1])
        return 1 / k;
    }
    return null;
  }

  const api = { detectSplit, SPLIT_RATIOS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VantageSplits = api;
})(typeof window !== 'undefined' ? window : globalThis);
