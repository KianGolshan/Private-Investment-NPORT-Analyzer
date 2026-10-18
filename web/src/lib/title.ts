// The browser tab's title as the visitor moves around (review 2026-10-15 N4).
// The server writes the first page's <title> for link previews
// (lib/api/pages.js); after that the workspace navigates without a reload, so
// each page sets its own. The texts equal the server's (test/title.test.ts).
import { useEffect } from 'preact/hooks';

export const SITE = 'Vantage';
export const DEFAULT_TITLE = 'Vantage: private-company holdings and marks from SEC fund filings';

/** The fixed pages' titles, the same as lib/api/pages.js STATIC_PAGES. */
export const PAGE_TITLES = {
  explore: 'Explore: private holdings by firm, fund, company and class',
  activity: "What's new: changes in newly filed N-PORT reports",
  firms: 'Firms by private value',
  watchlist: 'Watchlist and tracked companies',
  compare: 'Compare private companies, firms and funds',
  about: 'About',
  status: 'Data status',
  notFound: 'Not found',
} as const;

/** The title for an item page, the same as the server's pageMeta. */
export const itemTitle = {
  company: (name: string) => `${name}: fund holdings and marks`,
  fund: (name: string) => `${name}: private holdings`,
  firm: (name: string) => `${name}: private-company book`,
};

export const fullTitle = (title: string | null) => (title ? `${title} · ${SITE}` : DEFAULT_TITLE);

/** Sets the tab title while the page is shown; null is the home page's title. */
export function usePageTitle(title: string | null) {
  useEffect(() => {
    document.title = fullTitle(title);
  }, [title]);
}
