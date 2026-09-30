/* global window */
// Peer mark analytics shared by the browser (public/app.js, served as
// /peer.js) and Node (ROADMAP §5b task 5; P6's firm and class analytics), in
// the same way as public/splits.js. Moved unchanged from public/app.js: split
// detection comes from the shared splits module, and the leaderboard takes the
// instrument labels and the clock as options.
//
// Input: v1's buckets ({ equity: { fund: holdings[] }, debt, derivative,
// indirect }), each holding with reportDate, chartValue, shares,
// pricePerShare, instrumentType, instrumentLabel and instrumentKey (the company
// page builds them from the warehouse history, historyToBuckets).
(function (root) {
  const splits = typeof module !== 'undefined' && module.exports ? require('../../public/splits') : root.VantageSplits;
  const INSTRUMENT_ORDER = ['equity', 'debt', 'derivative', 'indirect'];

  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function dateCmp(a, b) {
    return new Date(a) - new Date(b);
  }

  // Splits one company's holdings into per-instrument series, computing a
  // disambiguated label so same-fund holdings that collide on the same
  // fallback label (e.g. two rows both generically "Preferred", per the real
  // BlackRock case found in the Databricks survey) are still visually
  // distinguishable even though instrumentKey already keeps them as separate
  // data series.
  function groupCompanyByInstrumentKey(company, holdings) {
    const byKey = {};
    holdings.forEach(h => {
      const k = h.instrumentKey || company;
      (byKey[k] ||= []).push(h);
    });
    const keys = Object.keys(byKey);
    const multi = keys.length > 1;

    const labelCounts = {};
    keys.forEach(k => {
      const lbl = byKey[k][0].instrumentLabel || '';
      labelCounts[lbl] = (labelCounts[lbl] || 0) + 1;
    });

    return keys.map(k => {
      const hs = byKey[k].slice().sort((a, b) => dateCmp(a.reportDate, b.reportDate));
      const baseLabel = hs[0].instrumentLabel || '';
      const collision = multi && labelCounts[baseLabel] > 1;
      const shortLabel = collision ? `${baseLabel} (…${String(k).slice(-6)})` : baseLabel;
      const fullLabel = multi ? `${company} — ${shortLabel}` : company;
      // baseLabel (pre-disambiguation) is what chips/filtering group by —
      // the disambiguation suffix exists so two colliding rows are tellable
      // apart *within one fund's table*, not to fragment the section-wide
      // "toggle everything in this class" control into one chip per
      // collision (real case: ~15 funds each with one unlabeled "Common"
      // row produced ~15 near-duplicate chips before this fix).
      return { company, key: k, baseLabel, shortLabel, fullLabel, holdings: hs };
    });
  }

  // Flat list of (company, instrumentKey) series across an entire bucket —
  // what the chart actually plots one line per.
  function getSeriesGroups(companiesMap) {
    return Object.keys(companiesMap).flatMap(company => groupCompanyByInstrumentKey(company, companiesMap[company]));
  }

  // ── Mark analytics: velocity, outliers, and the mark-event ledger ─────────
  // Funds report on different fiscal calendars (real Databricks holders span
  // nine different month-ends), so nothing here assumes filings line up in
  // time: velocity compares a series with its OWN earlier filing, outliers
  // compare against peers' as-of values within a staleness window, and the
  // ledger only orders each fund's own mark changes by date — no interpolated
  // "consensus" line is ever fitted across funds.
  const MARK_DAY_MS = 86400000;
  const VELOCITY_MIN_DAYS = 30;
  const ANNUALIZE_MIN_DAYS = 180;
  const OUTLIER_MIN_REL_DEV = 0.15;
  const OUTLIER_MAX_STALENESS_DAYS = 135;
  const OUTLIER_MIN_PEERS = 4;
  const MARK_EVENT_MIN_MOVE = 0.05;
  const EPISODE_WINDOW_DAYS = 150;
  const EPISODE_MIN_FUNDS = 3;

  // Observations for one series, with prices restated onto the latest share
  // basis whenever a stock split is detected between consecutive filings (a
  // 5-for-1 split would otherwise read as a ~68% markdown). Marks are compared
  // only within a series, so restating earlier prices is enough.
  function seriesObservations(series) {
    const obs = series.holdings
      .filter(h => h.chartValue != null && h.chartValue > 0 && h.reportDate)
      .map(h => ({
        t: Date.parse(h.reportDate),
        date: h.reportDate,
        value: h.chartValue,
        shares: h.shares,
        pps: h.pricePerShare,
        isDebt: h.instrumentType === 'debt',
      }))
      .filter(o => Number.isFinite(o.t))
      .sort((a, b) => a.t - b.t);

    let cumulative = 1;
    for (let i = obs.length - 1; i >= 0; i--) {
      obs[i].adjValue = obs[i].value / cumulative;
      if (i > 0 && !obs[i].isDebt) {
        const ratio = splits.detectSplit(
          { shares: obs[i - 1].shares, pricePerShare: obs[i - 1].pps },
          { shares: obs[i].shares, pricePerShare: obs[i].pps }
        );
        if (ratio) {
          obs[i - 1].splitAfter = ratio;
          cumulative *= ratio;
        }
      }
    }
    return obs.map(o => ({ ...o, value: o.adjValue }));
  }

  // Latest mark vs. the most recent earlier mark at least VELOCITY_MIN_DAYS
  // back. Annualized only when that gap is long enough to mean something.
  function computeMarkVelocity(series) {
    const obs = seriesObservations(series);
    if (obs.length < 2) return null;
    const last = obs[obs.length - 1];
    let prev = null;
    for (let i = obs.length - 2; i >= 0; i--) {
      if ((last.t - obs[i].t) / MARK_DAY_MS >= VELOCITY_MIN_DAYS) {
        prev = obs[i];
        break;
      }
    }
    if (!prev) return null;
    const days = (last.t - prev.t) / MARK_DAY_MS;
    const ratio = last.value / prev.value;
    // Annualizing a single quarter's move explodes (a 60% quarter reads as
    // +500%/yr), so the annualized figure uses a trailing window of at least
    // ANNUALIZE_MIN_DAYS instead; the raw latest-interval change is always shown.
    let annualizedPct = null;
    let annualizedDays = null;
    for (let i = obs.length - 2; i >= 0; i--) {
      const d = (last.t - obs[i].t) / MARK_DAY_MS;
      if (d >= ANNUALIZE_MIN_DAYS) {
        annualizedPct = (Math.pow(last.value / obs[i].value, 365 / d) - 1) * 100;
        annualizedDays = Math.round(d);
        break;
      }
    }
    const first = obs[0];
    const spanDays = (last.t - first.t) / MARK_DAY_MS;
    return {
      latestPct: (ratio - 1) * 100,
      splitAdjusted: obs.some(o => o.splitAfter),
      days: Math.round(days),
      annualizedPct,
      annualizedDays,
      priorDate: prev.date,
      sinceFirstPct: spanDays >= VELOCITY_MIN_DAYS ? (last.value / first.value - 1) * 100 : null,
      spanDays: Math.round(spanDays),
    };
  }

  function madStats(values) {
    const med = median(values);
    const mad = median(values.map(v => Math.abs(v - med)));
    return { med, mad };
  }

  // Flags a series whose latest mark is far from what same-class peers were
  // carrying as of that date. Peer value = the peer's most recent observation
  // at or before this date, ignored if older than the staleness window.
  function computeOutlierFlags(seriesList) {
    const result = {};
    const byClass = {};
    seriesList.forEach(sr => (byClass[sr.baseLabel] ||= []).push(sr));

    Object.values(byClass).forEach(group => {
      const withObs = group.map(sr => ({ sr, obs: seriesObservations(sr) })).filter(g => g.obs.length);
      withObs.forEach(({ sr, obs }) => {
        const latest = obs[obs.length - 1];
        const peers = [];
        withObs.forEach(other => {
          if (other.sr === sr || other.sr.company === sr.company) return;
          const asOf = [...other.obs].reverse().find(o => o.t <= latest.t);
          if (asOf && (latest.t - asOf.t) / MARK_DAY_MS <= OUTLIER_MAX_STALENESS_DAYS) peers.push(asOf.value);
        });
        if (peers.length < OUTLIER_MIN_PEERS) return;
        const { med, mad } = madStats(peers);
        const relDev = med ? (latest.value - med) / med : 0;
        let z = null;
        let flagged;
        if (mad > 0) {
          z = (0.6745 * (latest.value - med)) / mad;
          flagged = Math.abs(z) > 3.5 && Math.abs(relDev) >= OUTLIER_MIN_REL_DEV;
        } else {
          flagged = Math.abs(relDev) >= OUTLIER_MIN_REL_DEV; // peers agree exactly; any material gap stands out
        }
        if (flagged) {
          result[`${sr.company}||${sr.key}`] = {
            direction: latest.value > med ? 'high' : 'low',
            z,
            peerMedian: med,
            relDevPct: relDev * 100,
            peerCount: peers.length,
          };
        }
      });
    });
    return result;
  }

  // Each fund's own consecutive-filing mark changes of at least 5%, grouped
  // into "repricing episodes" (same direction, within ~5 months of the first
  // mover, 3+ different funds). Lead score = how early a fund's move landed
  // within its episodes (1 = first, 0 = last), averaged across episodes.
  function buildMarkEventLedger(seriesList) {
    const events = [];
    seriesList.forEach(sr => {
      const obs = seriesObservations(sr);
      for (let i = 1; i < obs.length; i++) {
        const change = obs[i].value / obs[i - 1].value - 1;
        if (Math.abs(change) >= MARK_EVENT_MIN_MOVE) {
          events.push({
            company: sr.company,
            label: sr.fullLabel,
            t: obs[i].t,
            date: obs[i].date,
            prevDate: obs[i - 1].date,
            pct: change * 100,
            dir: change > 0 ? 'up' : 'down',
          });
        }
      }
    });
    events.sort((a, b) => a.t - b.t);

    const episodes = [];
    ['up', 'down'].forEach(dir => {
      let current = null;
      events
        .filter(e => e.dir === dir)
        .forEach(e => {
          if (
            current &&
            (e.t - current.startT) / MARK_DAY_MS <= EPISODE_WINDOW_DAYS &&
            !current.events.some(x => x.company === e.company)
          ) {
            current.events.push(e);
          } else {
            if (current) episodes.push(current);
            current = { dir, startT: e.t, events: [e] };
          }
        });
      if (current) episodes.push(current);
    });

    const real = episodes.filter(ep => ep.events.length >= EPISODE_MIN_FUNDS).sort((a, b) => b.startT - a.startT);

    const scores = {};
    real.forEach(ep => {
      const n = ep.events.length;
      ep.events.forEach((e, idx) => {
        const rank = ep.events.findIndex(x => x.t === e.t); // ties share the earlier rank
        (scores[e.company] ||= []).push(1 - rank / (n - 1));
        void idx;
      });
    });
    const leaders = Object.entries(scores)
      .filter(([, arr]) => arr.length >= 2)
      .map(([company, arr]) => ({
        company,
        episodes: arr.length,
        leadScore: arr.reduce((a, b) => a + b, 0) / arr.length,
      }))
      .sort((a, b) => b.leadScore - a.leadScore);

    return { episodes: real, leaders };
  }

  function computeLeaderboardRows(batchResults, { meta = {}, now = Date.now() } = {}) {
    return Object.keys(batchResults).flatMap(security => {
      const buckets = batchResults[security];
      const types = INSTRUMENT_ORDER.filter(t => buckets[t] && Object.keys(buckets[t]).length > 0);
      // One row per bucket a security actually has (not just the primary
      // one) — a security held as both equity and debt across the basket
      // must not have its debt holdings silently dropped from the ranking.
      // The security label only gets a "(Debt / Loans)"-style suffix when
      // there's more than one bucket, so the common single-bucket case is
      // visually unchanged.
      const multi = types.length > 1;

      return types
        .map(type => {
          const companiesMap = buckets[type];

          const latestPerFund = Object.values(companiesMap)
            .map(holdings => [...holdings].sort((a, b) => dateCmp(b.reportDate, a.reportDate))[0])
            .filter(h => h && h.chartValue != null && h.chartValue > 0);
          if (!latestPerFund.length) return null;

          const values = latestPerFund.map(h => h.chartValue);
          const minValue = Math.min(...values);
          const maxValue = Math.max(...values);
          const medianValue = median(values);
          const mostRecent = [...latestPerFund].sort((a, b) => dateCmp(b.reportDate, a.reportDate))[0];
          const dispersionPct = medianValue ? ((maxValue - minValue) / medianValue) * 100 : null;
          const ageDays = mostRecent.reportDate ? Math.round((now - new Date(mostRecent.reportDate)) / 86400000) : null;

          const velocities = getSeriesGroups(companiesMap)
            .map(sr => computeMarkVelocity(sr))
            .filter(v => v && v.annualizedPct != null)
            .map(v => v.annualizedPct);
          const velocityPct = velocities.length ? median(velocities) : null;

          return {
            velocityPct,
            security,
            label: multi ? `${security} (${meta[type]?.sectionTitle || type})` : security,
            type,
            meta: meta[type],
            latestValue: mostRecent.chartValue,
            latestDate: mostRecent.reportDate,
            minValue,
            maxValue,
            medianValue,
            fundCount: latestPerFund.length,
            dispersionPct,
            ageDays,
          };
        })
        .filter(Boolean);
    });
  }

  const api = {
    median,
    groupCompanyByInstrumentKey,
    getSeriesGroups,
    seriesObservations,
    computeMarkVelocity,
    computeOutlierFlags,
    buildMarkEventLedger,
    computeLeaderboardRows,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VantagePeer = api;
})(typeof window !== 'undefined' ? window : globalThis);
