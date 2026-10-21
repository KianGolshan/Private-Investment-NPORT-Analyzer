// The words Vantage uses, defined once (review 2026-10-15 W3). The in-page
// "what is this?" popovers (ui/Term.tsx) and the About page read the same text,
// so a definition never says one thing here and another there. Every claim is
// true of the data today; see docs/DATA-QUALITY.md for the rules behind them.

export type TermId =
  | 'mark'
  | 'markDate'
  | 'asOf'
  | 'nport'
  | 'ncen'
  | 'fairValueLevel'
  | 'indirect'
  | 'fromPositions'
  | 'fromMarks'
  | 'otherChanges'
  | 'bridge'
  | 'tracked'
  | 'sector'
  | 'markIndex';

export const GLOSSARY: Record<TermId, { term: string; text: string }> = {
  sector: {
    term: 'Sector, industry and theme',
    text: 'Vantage’s labels for each private operating company: one sector and industry (so they add up to the total) and any number of themes such as AI or Fintech (these overlap, so they do not add up). N-PORT has no industry field: the labels are reviewed decisions, with a confidence, not filed facts. “AI” means the core product is an AI model or system, or the compute, chips or data platforms used to build and run models.',
  },
  markIndex: {
    term: 'Per-share mark index',
    text: 'How marks moved, following each fund’s own security from report to report (split-adjusted). A company moves with the median of its funds, so a step-up funds report in different quarters counts once. The index follows the companies marked at the start (later arrivals cannot move it) and is shown for the typical company (the median) and weighted by value. It is not shown with fewer than 5 companies.',
  },
  mark: {
    term: 'Mark',
    text: 'The value a fund reports for a holding. A per-share mark is that value divided by the shares reported, adjusted for known share splits.',
  },
  markDate: {
    term: 'Mark date',
    text: 'The date a fund’s report describes (its report date), not the day it was filed. Funds report on different fiscal calendars, so mark dates differ by fund.',
  },
  asOf: {
    term: 'As of',
    text: 'As of a date, each fund counts with its latest report on or before that date, if that report is no more than 123 days old. A report filed after the date still counts, since it reports on or before it; Market and Firms can count only the reports filed by then.',
  },
  nport: {
    term: 'N-PORT',
    text: 'The holdings report SEC-registered funds (mutual funds, ETFs, closed-end and interval funds) file for each fiscal quarter, within 60 days of its end.',
  },
  ncen: {
    term: 'Form N-CEN',
    text: 'A yearly SEC report in which each fund names its investment adviser. Vantage groups funds into firms by that adviser.',
  },
  fairValueLevel: {
    term: 'Fair-value level',
    text: 'How a fund labels a holding’s price: level 1 (quoted), 2 (observable inputs) or 3 (unobservable inputs). Private is decided by the company, not the level.',
  },
  indirect: {
    term: 'Held indirectly',
    text: 'Held through a named SPV (special purpose vehicle) or as an interest in another fund, rather than as the company’s own shares.',
  },
  fromPositions: {
    term: 'From positions',
    text: 'The change in value from shares first reported, added, reduced or no longer reported, valued at the prior mark.',
  },
  fromMarks: {
    term: 'From marks',
    text: 'The change in value from new marks on the shares a fund held at both reports.',
  },
  otherChanges: {
    term: 'Other changes',
    text: 'Funds that started or stopped filing, and holdings reported with no share count: changes that are neither a position nor a mark.',
  },
  bridge: {
    term: 'Bridge',
    text: 'The value at the start, each kind of change, and the value at the end. The steps add up exactly to the closing value.',
  },
  tracked: {
    term: 'Tracked companies',
    text: 'Private companies picked by hand in Vantage’s reviewed list for a closer look.',
  },
};
