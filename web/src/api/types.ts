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
  type: 'company' | 'entity';
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
