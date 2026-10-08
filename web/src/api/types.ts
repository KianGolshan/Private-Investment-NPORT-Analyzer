// Response shapes of the warehouse API (lib/api/warehouse.js). They mirror the
// services' output; only the fields the UI reads are typed. Every answer
// carries source and refreshId; every value row carries its fund's mark date
// and accession (DATA-QUALITY display rules).

export interface Envelope {
  source: string;
  /** The published warehouse generation the answer was read from (ADR 0009). */
  refreshId: number;
  /** Cross-company answers: how history is read (today's curation and advisers, F14). */
  basis?: {
    generation: number | null;
    curationRev: string | null;
    curationDigest: string | null;
    companies: string;
    firms: string;
  };
}

export interface Freshness extends Envelope {
  refreshedAt: string | null;
  newestFilingDate: string | null;
  newestReportDate: string | null;
  latestBulkQuarter: string | null;
  /** The published generation (ADR 0009); null on a warehouse from before generations. */
  generation?: {
    id: number;
    publishedAt: string;
    status: string;
    curationRev: string | null;
    /** sha256 of the exact data/review files the generation reflects (curation_snapshot) */
    curationDigest: string | null;
    codeRev: string | null;
  } | null;
  /** The last warehouse job, apart from the data version. */
  job?: {
    kind: string;
    /** running, ok, partial, failed, or interrupted (its process ended mid-run) */
    status: string;
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
    /** published, with warnings (validation, post-commit cleanup) */
    warning?: string | null;
  } | null;
}

export interface Company {
  id: number;
  name: string;
  status: 'private' | 'public';
  public_since: string | null;
  tracked: boolean;
}

export interface CompanyStats {
  current_funds: number;
  current_value_usd: number;
  as_of: string | null;
  funds_ever: number;
  first_mark_date: string | null;
  last_mark_date: string | null;
}

export interface SearchHit {
  /** 'unreviewed' = an unreviewed name (opened by key). */
  type: 'company' | 'unreviewed';
  id?: number;
  key?: string;
  name: string;
  status?: string;
  tracked?: boolean;
  reviewed?: boolean;
  category?: string;
  evidence?: {
    currentFunds: number;
    currentValueUsd: number;
    asOf: string | null;
    fundsEver: number;
    firstMarkDate: string | null;
    lastMarkDate: string | null;
  };
  match: { how: string; via: string; text: string };
  strong?: boolean;
}

/** /api/search?kinds=…: one ranked list (P6b W1); the server's order is the ranking. */
export type UnifiedHit =
  | SearchHit
  | {
      type: 'firm';
      id: number;
      name: string;
      strong: boolean;
      evidence: { fundsManaged: number; fundsHolding: number; companies: number; value: number };
    }
  | { type: 'fund'; fundKey: string; name: string; strong: boolean; fund: FundInfo }
  | {
      type: 'class';
      companyId: number;
      company: string;
      classLabel: string;
      name: string;
      strong: boolean;
      evidence: { currentFunds: number; currentValueUsd: number; asOf: string | null };
    };

export interface FundRef {
  fundKey: string;
  cik: string;
  seriesId?: string | null;
  registrant: string;
  seriesName: string | null;
  fundLabel?: string;
}

export interface Position {
  rowKey: string;
  issuerName: string;
  title: string;
  instrumentKey: string;
  balance: number | null;
  unit: string | null;
  valueUsd: number;
  pricePerShare: number | null;
  pricePerUnit: number | null;
  assetCat: string | null;
  instrumentType: string;
  instrumentLabel: string;
  /** The class the class views group by (instrumentLabel with "F1" = "F-1"). */
  classLabel: string;
  fvLevel: string | null;
  viaSpv: boolean;
  /** How the fund holds it: directly, through a named SPV, or as a fund interest the filer files as one. */
  kind: 'direct' | 'spv' | 'fund';
  /** Percent of the fund's net assets as filed (N-PORT pctVal): 0.83 means 0.83%. */
  pctNav: number | null;
}

export interface FirmRef {
  id: number;
  name: string;
}

export interface Holding extends FundRef {
  markDate: string;
  filingDate: string;
  accession: string;
  form: string;
  source: string;
  lastHeldDate?: string;
  lastHeldAccession?: string;
  value?: number;
  positions?: Position[];
  indirect?: boolean;
  label: string | null;
  /** The fund's advising firms (current N-CEN adviser). */
  firms?: FirmRef[];
}

export interface Exposure extends Envelope {
  company: Company;
  date: string;
  knownAsOf: string | null;
  funds: number;
  total: number;
  holdings: Holding[];
  zeroValue: Holding[];
  exited: Holding[];
  inactive: Holding[];
  disclosedExposure: {
    fundKey: string;
    registrant: string | null;
    seriesName: string | null;
    markDate: string;
    accession: string;
    basis: string;
  }[];
}

export interface TrendPoint {
  date: string;
  funds: number;
  total: number;
  entered: number;
  left: number;
  zeroValue: number;
}

export interface Leg {
  instrumentKey: string;
  instrument: string;
  title: string;
  unit: string | null;
  viaSpv: boolean;
  prevBalance: number | null;
  balance: number | null;
  prevValue: number;
  value: number;
  prevPrice: number | null;
  price: number | null;
  perShare: boolean;
  split: number | null;
  priceChangePct?: number | null;
  balanceChange?: number | null;
  change: string;
  /** The filer's previous instrument id when it re-keyed the same holding (activity.rekeyed). */
  rekeyedFrom?: string;
  /** One class held under several filer ids, merged into this leg (trap 52). */
  mergedKeys?: string[];
  /** value - prevValue = positionEffect + markEffect + otherEffect (lib/analytics/activity.js leg()). */
  positionEffect: number;
  markEffect: number;
  otherEffect: number;
}

export interface ChangeEvent extends FundRef {
  companyId?: number;
  company?: string;
  tracked?: boolean;
  type: string;
  label: string;
  markDate: string;
  filingDate: string;
  accession: string;
  prevMarkDate: string | null;
  prevAccession: string | null;
  value: number;
  prevValue: number;
  valueChange: number;
  /** Shares changed, at the prior mark. */
  positionEffect: number;
  /** The new mark on the shares now held. */
  markEffect: number;
  /** Rows with no share count: the value changed, not split. */
  otherEffect: number;
  markChangePct: number | null;
  instruments: Leg[];
  firms?: FirmRef[];
}

export interface Activity extends Envelope {
  company: Company;
  events: ChangeEvent[];
  byMonth: {
    month: string;
    new: number;
    added: number;
    reduced: number;
    mixed: number;
    exited: number;
    zeroed: number;
    markUps: number;
    markDowns: number;
  }[];
}

export interface ClassMark {
  fundKey: string;
  fund: string;
  firm: string | null;
  firms: { id: number; name: string }[];
  cik: string;
  markDate: string;
  accession: string;
  balance: number | null;
  unit: string | null;
  pricePerShare: number | null;
  pricePerUnit: number | null;
  value: number;
  viaSpv: boolean;
  vsFilingLowPct: number | null;
}

export interface ClassesAsOf extends Envelope {
  company: Company;
  date: string;
  classes: {
    instrument: string;
    value: number;
    funds: number;
    byMarkDate: {
      markDate: string;
      funds: number;
      median: number | null;
      low: number | null;
      high: number | null;
      spreadPct: number | null;
      firms: { id: number; name: string }[];
    }[];
    marks: ClassMark[];
  }[];
  /** Filings that mark two or more classes apart: each class against the filing's lowest (F30). */
  withinFiling: {
    fundKey: string;
    fund: string;
    firm: string | null;
    firms: FirmRef[];
    cik: string;
    markDate: string;
    accession: string;
    classes: { instrument: string; pricePerShare: number; vsLowPct: number }[];
  }[];
}

export interface MarkSeries extends Envelope {
  company: Company;
  classes: string[];
  /** One firm's funds on one class at one mark date. */
  firmSeries: {
    markDate: string;
    instrument: string;
    firmId: number;
    firm: string;
    funds: number;
    median: number;
    low: number;
    high: number;
  }[];
  series: {
    markDate: string;
    instrument: string;
    funds: number;
    firms: number;
    median: number | null;
    low: number | null;
    high: number | null;
  }[];
}

export interface Firm {
  id: number;
  name: string;
  fundsManaged: number;
  fundsHolding: number;
  companies: number;
  value: number;
}

export interface FirmBook extends Envelope {
  firm: { id: number; name: string; fundsManaged: number; fundsSubadvised: number };
  date: string;
  value: number;
  companies: number;
  byCompany: {
    companyId: number;
    name: string;
    tracked: boolean;
    value: number;
    funds: number;
    positions: {
      fundKey: string;
      fund: string;
      cik: string;
      markDate: string;
      accession: string;
      instrument: string;
      title: string;
      balance: number | null;
      unit: string | null;
      pricePerShare: number | null;
      pricePerUnit: number | null;
      value: number;
      pctNav: number | null;
      viaSpv: boolean;
    }[];
  }[];
  byFund: (FundRef & {
    markDate: string;
    accession: string;
    netAssets: number | null;
    label: string;
    value: number;
    companies: number;
  })[];
}

export interface FundInfo {
  fundKey: string;
  cik: string;
  seriesId: string | null;
  seriesName: string | null;
  registrant: string;
  firstReportDate: string;
  lastReportDate: string;
  lastAccession: string;
  lastNetAssets: number | null;
  filings: number;
  inactive: boolean;
}

export interface FundFilings extends Envelope {
  fund: FundInfo;
  filings: {
    accession: string;
    reportDate: string;
    filingDate: string;
    form: string;
    source: string;
    versions: number;
    netAssets: number | null;
  }[];
}

export interface TopCompanies extends Envelope {
  date: string;
  companies: number;
  totalValue: number;
  results: {
    rank: number;
    companyId: number;
    name: string;
    tracked: boolean;
    funds: number;
    value: number;
    oldestMark: string;
    newestMark: string;
    indirectValue: number;
  }[];
}

export interface Feed extends Envelope {
  since: string;
  until: string;
  /** Who: tracked companies or every reviewed private company. */
  scope: string;
  /** The firm and fund filters applied (P6b W4). */
  filters?: ScopeEcho['scope'];
  count: number;
  /** Every match (F16); `events` is one page of them. */
  total: number;
  /** Events by type over every match; mark moves (unchanged shares) as markMoved. */
  breakdown: Partial<
    Record<'new' | 'added' | 'reduced' | 'mixed' | 'exited' | 'zeroed' | 'markMoved' | 'unchanged', number>
  >;
  offset: number;
  limit: number;
  truncated: boolean;
  events: ChangeEvent[];
}

// ── P6b W1/W2: analysis answers (lib/services/analysis.js) ──

export interface ScopeEcho {
  scope?: { firm?: number[]; fund?: string[]; class?: string[]; kind?: string[] } | null;
}

export interface BridgeStep {
  key: 'firstReported' | 'added' | 'reduced' | 'exited' | 'mark' | 'valueOnly' | 'started' | 'stopped';
  label: string;
  value: number;
  events: number;
}

export interface Bridge extends Envelope, ScopeEcho {
  from: string;
  to: string;
  label: string;
  start: { value: number; funds: number };
  end: { value: number; funds: number };
  steps: BridgeStep[];
  positionEffect: number;
  markEffect: number;
  residual: number;
  reconciled: boolean;
}

export type PivotMetric =
  | 'value'
  | 'holders'
  | 'firstReported'
  | 'added'
  | 'reduced'
  | 'exited'
  | 'mark'
  | 'valueOnly'
  | 'started'
  | 'stopped'
  | 'positionEffect'
  | 'markEffect';

export type PivotCells = Record<PivotMetric, number[]> & { startValue: number };

export interface Pivot extends Envelope, ScopeEcho {
  rows: 'firm' | 'fund' | 'company' | 'class';
  period: 'month' | 'quarter' | 'year';
  from: string;
  to: string;
  label: string;
  periods: { label: string; from: string; to: string; partial: boolean }[];
  metrics: PivotMetric[];
  count: number;
  results: (PivotCells & { key: string | number; label: string })[];
  total: PivotCells;
}

/** One change leg of one fund at one filing (position facts). */
export interface FactLeg {
  fundKey?: string;
  markDate: string;
  accession: string;
  filingDate: string;
  prevMarkDate: string | null;
  prevAccession: string | null;
  nextMarkDate: string | null;
  event: string;
  label: string;
  change: string;
  instrumentKey: string;
  rekeyedFrom: string | null;
  mergedKeys: string[] | null;
  classLabel: string;
  instrument: string | null;
  kind: 'direct' | 'spv' | 'fund';
  unit: string | null;
  title: string | null;
  balance: number | null;
  prevBalance: number | null;
  price: number | null;
  prevPrice: number | null;
  perShare: boolean;
  value: number;
  prevValue: number;
  split: number | null;
  positionEffect: number;
  markEffect: number;
  otherEffect: number;
  pctNav: number | null;
}

export interface LegsAt extends Envelope, ScopeEcho {
  date: string;
  legs: (FactLeg & { fundKey: string })[];
}

export interface PositionHistory extends Envelope, ScopeEcho {
  fund: FundRef & { label: string };
  legs: FactLeg[];
}

export interface FilingRow {
  fundKey: string;
  cik: string;
  registrant: string;
  seriesName: string | null;
  markDate: string;
  filingDate: string;
  accession: string;
  rowKey: string;
  issuerName: string | null;
  title: string | null;
  otherId: string | null;
  otherIdDesc: string | null;
  cusip: string | null;
  isin: string | null;
  lei: string | null;
  restricted: string | null;
  assetCat: string | null;
  instrumentType: string;
  unit: string | null;
  balance: number | null;
  valueUsd: number;
  pctNav: number | null;
  fvLevel: string | null;
  country: string | null;
  viaSpv: boolean;
  counts: boolean;
}

export interface FilingRows extends Envelope, ScopeEcho {
  from: string | null;
  to: string | null;
  count: number;
  /** Distinct filings and funds over every matching row (not only the rows returned). */
  filings: number;
  funds: number;
  truncated: boolean;
  rows: FilingRow[];
}

export interface Leadership extends Envelope, ScopeEcho {
  tolerancePct: number;
  levels: {
    instrument: string;
    mark: number;
    firstDate: string;
    firms: number;
    adopters: {
      firmId: number;
      firm: string;
      markDate: string;
      mark: number;
      prevMarkDate: string;
      prevMark: number;
      lagDays: number;
      movePct: number;
      funds: number;
    }[];
  }[];
  firms: { firmId: number; firm: string; levels: number; first: number; medianLagDays: number | null }[];
}

export interface CompanyHistory extends Envelope, ScopeEcho {
  firstMarkDate: string | null;
  lastMarkDate: string | null;
  funds: (FundRef & {
    label: string;
    firstMarkDate: string;
    lastMarkDate: string;
    series: {
      instrumentKey: string;
      title: string;
      instrumentLabel: string;
      chartUnit: string;
      points: {
        markDate: string;
        accession: string;
        balance: number | null;
        unit: string | null;
        valueUsd: number;
        pricePerShare: number | null;
        pricePerUnit: number | null;
        splitFactor: number;
        split: number | null;
        kind: 'direct' | 'spv' | 'fund';
      }[];
    }[];
  })[];
}

// ── P6b W3: firm and fund pages ──

export interface Timeline extends Envelope {
  firm?: number;
  fund?: string;
  asOf: string;
  attribution: string;
  companies: {
    companyId: number;
    name: string;
    firstHeld: string;
    /** null = still held as of asOf */
    lastHeld: string | null;
    spans: { from: string; until: string | null }[];
    value: number;
    funds: number;
    positionEffect: number;
    markEffect: number;
    events: {
      markDate: string;
      type: string;
      label: string;
      funds: number;
      valueChange: number;
      positionEffect: number;
      markEffect: number;
    }[];
  }[];
}

export interface MarksVsOthers extends Envelope {
  firm?: number;
  fund?: string;
  date: string;
  tolerancePct: number;
  summary: {
    positions: number;
    compared: number;
    above: number;
    same: number;
    below: number;
    valueAbove: number;
    valueSame: number;
    valueBelow: number;
  };
  rows: {
    companyId: number;
    company: string;
    classLabel: string;
    markDate: string;
    mark: number;
    funds: number;
    value: number;
    othersMedian: number | null;
    othersLow: number | null;
    othersHigh: number | null;
    otherFunds: number;
    otherFirms: number;
    diffPct: number | null;
    position: 'above' | 'same' | 'below' | 'no other fund that date';
  }[];
}

export interface FirmChanges extends Envelope {
  firm: { id: number; name: string };
  since: string;
  until: string;
  count: number;
  offset: number;
  byType: Record<string, number>;
  totals: { valueChange: number; positionEffect: number; markEffect: number; otherEffect: number };
  events: ChangeEvent[];
}

/** One holding row in X-Ray's shape (lib/services/fund.js forDisplay). */
export interface XrayHolding {
  name: string;
  title: string;
  shares: number | null;
  marketValue: number;
  pricePerShare: number | null;
  unit: string | null;
  perShare: boolean;
  instrumentType: string;
  instrumentLabel: string;
  instrumentKey: string;
  filerId: string | null;
  fairValLevel: string | null;
  isRestrictedSec: string | null;
  pctOfNetAssets: number | null;
  country: string | null;
  rowKey: string;
  privateKind: 'company' | 'fund' | 'vehicle';
  company: { id: number; name: string; tracked: boolean } | null;
  unreviewed: { key: string; name?: string } | null;
  labels: string[];
  reason?: string;
}

export interface Xray extends Envelope {
  fund: FundInfo;
  xray: {
    fund: { seriesName: string | null; registrantName: string; reportDate: string; netAssets: number | null };
    filing: { accession: string; reportDate: string; filingDate: string; form: string; versions: number; cik: string };
    markDate: string;
    accession: string;
    totalHoldingsCount: number;
    publicHoldingsCount: number;
    privateHoldingsCount: number;
    privateValueUSD: number;
    privateByKind: Record<'company' | 'fund' | 'vehicle', { label: string; rows: number; valueUSD: number }>;
    totalValueUSD: number;
    /** null unless the filing reports positive net assets (never total value under this label) */
    privatePctOfNetAssets: number | null;
    privatePctOfHoldingsValue: number | null;
    listedValueUSD: number;
    debtValueUSD: number;
    byCountry: Record<string, number>;
    privateHoldings: XrayHolding[];
    notPrivate: XrayHolding[];
    capitalStructure: {
      issuer: string;
      totalValueUSD: number;
      pctOfNetAssets: number | null;
      byType: Record<string, number>;
      debtPctOfExposure: number;
      weightedDebtCouponPct: number | null;
      instruments: {
        title: string;
        instrumentType: string;
        instrumentLabel: string;
        marketValue: number;
        shares: number | null;
        couponPct: number | null;
        maturity: string | null;
      }[];
    }[];
    /** lists cut to the `shown` largest rows by value; the counts are the full lists' (lib/services/fund.js forDisplay) */
    truncated: { shown: number; privateHoldings: number; notPrivate: number } | null;
  };
}

interface Delta {
  current: number | null;
  prior: number | null;
  delta: number | null;
  deltaPct: number | null;
}

export interface XrayCompare extends Envelope {
  fund: FundInfo;
  current: { accession: string; markDate: string; privateValueUSD: number; privateHoldingsCount: number };
  prior: { accession: string; markDate: string; privateValueUSD: number; privateHoldingsCount: number } | null;
  comparison: {
    totals: {
      privateValueUSD: Delta;
      privateHoldingsCount: Delta;
      issuerCount: Delta;
      newCount: number;
      exitedCount: number;
      continuingCount: number;
      valueChangeFromPrice: { amount: number; pct?: number };
      valueChangeFromShares: { amount: number; pct?: number };
      valueChangeOther: { amount: number };
    };
    positions: {
      key: string;
      splitRatio: number | null;
      name: string;
      title: string;
      instrumentLabel: string;
      status: string;
      shares: Delta;
      marketValue: Delta;
      pricePerShare: Delta;
      pctOfNetAssets: Delta;
      priceEffectUSD: number | null;
      shareEffectUSD: number | null;
    }[];
  } | null;
  positionsTotal?: number;
}

export interface XrayReturns extends Envelope {
  fund: FundInfo;
  filings: { accession: string; markDate: string }[];
  returns: {
    summary: {
      positionCount: number;
      invested: number;
      realized: number;
      currentValue: number;
      moic: number | null;
      irr: number | null;
      partialSales: number;
      leftPrivateBook: number;
      windowStartCount: number;
      excludedCount: number;
      firstDate: string;
      lastDate: string;
      periodCount: number;
    };
    positions: {
      name: string;
      title: string;
      instrumentLabel: string;
      status: string;
      firstDate: string;
      lastDate: string;
      entryIsWindowStart: boolean;
      lotsUnavailable: boolean;
      chainedFrom: string | null;
      invested: number;
      realized: number;
      currentValue: number;
      moic: number | null;
      irr: number | null;
      events: { type: string; date: string; ratio?: number }[];
    }[];
  };
}

// ── P6b W4: Explore drill, Market movers and newly reported, watchlist, Compare ──

export interface DrillEvent {
  fundKey: string;
  fundLabel?: string;
  cik?: string;
  companyId: number;
  company?: string;
  markDate: string;
  /** null for a fund that stopped filing (dated the day it dropped out). */
  accession: string | null;
  lastAccession: string;
  filingDate: string | null;
  event: string;
  label: string;
  amount: number;
  legs: (FactLeg & { step: string; amount: number })[];
}

export interface Drill extends Envelope, ScopeEcho {
  rows: Pivot['rows'];
  key: string | number | null;
  rowLabel: string;
  metric: PivotMetric;
  from: string;
  to: string;
  tracked?: boolean;
  label: string;
  total: number;
  funds: number;
  legCount: number;
  count: number;
  events: DrillEvent[];
}

export interface Mover {
  companyId: number;
  name: string;
  startValue: number;
  endValue: number;
  startFunds: number;
  endFunds: number;
  markEffect: number;
  positionEffect: number;
  firstReported: number;
  added: number;
  reduced: number;
  exited: number;
  started: number;
  stopped: number;
  valueOnly: number;
}

export interface Movers extends Envelope {
  from: string;
  to: string;
  tracked?: boolean;
  label: string;
  companies: number;
  markUp: Mover[];
  markDown: Mover[];
  flowIn: Mover[];
  flowOut: Mover[];
}

export interface NewlyReported extends Envelope {
  from: string;
  to: string;
  label: string;
  count: number;
  results: {
    companyId: number;
    name: string;
    tracked: boolean;
    firstMarkDate: string;
    firstFunds: number;
    firstValue: number;
    firstAccession: string;
    firstFund: string;
    firstFundLabel?: string;
    cik?: string;
    how: string[];
    funds: number;
    value: number;
  }[];
}

export type WatchKind = 'company' | 'firm' | 'fund';

export interface WatchlistAnswer extends Envelope {
  date: string;
  yearAgo: string;
  label: string;
  items: {
    kind: WatchKind;
    key: number | string;
    label: string | null;
    /** live; listed (reviewed public); merged into `successor`; dropped; unknown id. Numbers are null unless live. */
    status: SubjectStatus;
    value: number | null;
    funds: number | null;
    companies: number | null;
    valueYearAgo: number | null;
    fundsYearAgo: number | null;
    positionEffect: number | null;
    markEffect: number | null;
  }[];
}

export interface TrackedDashboard extends Envelope {
  date: string;
  yearAgo: string;
  companies: {
    companyId: number;
    name: string;
    funds: number;
    value: number;
    fundsYearAgo: number;
    valueYearAgo: number;
    holderChange: number;
    mainClass: string | null;
    markDate: string | null;
    median: number | null;
    markChange12mPct: number | null;
    markChangeFunds: number;
    dispersionPct: number | null;
    staleFunds: number;
  }[];
}

/** What a saved or compared subject is now (lib/services/analysis.js watchStatus). */
export interface SubjectStatus {
  state: 'live' | 'listed' | 'merged' | 'dropped' | 'unknown';
  successor?: number;
  name?: string;
}

export interface CompareMark {
  markDate: string;
  median: number;
  low: number;
  high: number;
  funds: number;
}

export interface Compare extends Envelope {
  rows: Pivot['rows'];
  period: Pivot['period'];
  from: string;
  to: string;
  label: string;
  periods: Pivot['periods'];
  metrics: PivotMetric[];
  count: number;
  /** A subject that is not live (unknown, listed, merged, dropped) has null numbers, never zeros (review R15). */
  results: (Record<PivotMetric, (number | null)[]> & {
    startValue: number | null;
    status: SubjectStatus;
    key: string | number;
    label: string | null;
    companies: number | null;
    funds: number | null;
    oldestMark: string | null;
    newestMark: string | null;
    markClass?: string;
    marks?: CompareMark[];
    spread?: { markDate: string; pct: number; funds: number } | null;
  })[];
}
