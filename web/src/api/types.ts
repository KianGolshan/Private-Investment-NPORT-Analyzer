// Response shapes of the warehouse API (lib/api/warehouse.js). They mirror the
// services' output; only the fields the UI reads are typed. Every answer
// carries source and refreshId; every value row carries its fund's mark date
// and accession (DATA-QUALITY display rules).

export interface Envelope {
  source: string;
  refreshId: number;
}

export interface Freshness extends Envelope {
  refreshedAt: string | null;
  newestFilingDate: string | null;
  newestReportDate: string | null;
  latestBulkQuarter: string | null;
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
  scope: string;
  count: number;
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
