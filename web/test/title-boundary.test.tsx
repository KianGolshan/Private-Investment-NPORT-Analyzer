// Review 2026-10-15 N4/N5: the tab title follows the page (the same texts the
// server writes for link previews), and a page that throws shows a way out,
// cleared when the visitor moves on.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/preact';
import { DEFAULT_TITLE, PAGE_TITLES, fullTitle, itemTitle, usePageTitle } from '../src/lib/title';
import { PageBoundary } from '../src/ui/PageBoundary';

const require = createRequire(import.meta.url);
const pages = require('../../lib/api/pages.js') as {
  DEFAULT_TITLE: string;
  STATIC_PAGES: Record<string, { title: string }>;
};

describe('page titles', () => {
  it('equal the server’s titles for every fixed page', () => {
    expect(DEFAULT_TITLE).toBe(pages.DEFAULT_TITLE);
    const client: Record<string, string> = {
      '/': DEFAULT_TITLE,
      '/explore': PAGE_TITLES.explore,
      '/activity': PAGE_TITLES.activity,
      '/firms': PAGE_TITLES.firms,
      '/watchlist': PAGE_TITLES.watchlist,
      '/compare': PAGE_TITLES.compare,
      '/about': PAGE_TITLES.about,
      '/status': PAGE_TITLES.status,
    };
    expect(Object.keys(client).sort()).toEqual(Object.keys(pages.STATIC_PAGES).sort());
    for (const [path, title] of Object.entries(client)) expect(title, path).toBe(pages.STATIC_PAGES[path]?.title);
    expect(itemTitle.company('Anthropic')).toBe('Anthropic: fund holdings and marks');
    expect(fullTitle(null)).toBe(DEFAULT_TITLE);
    expect(fullTitle('Data status')).toBe('Data status · Vantage');
  });

  it('change when the page changes, and the home page has the plain title', () => {
    const Page = ({ t }: { t: string | null }) => {
      usePageTitle(t);
      return null;
    };
    const { rerender } = render(<Page t={PAGE_TITLES.about} />);
    expect(document.title).toBe('About the data and methodology · Vantage');
    rerender(<Page t={itemTitle.firm('Capital Group (American Funds)')} />);
    expect(document.title).toBe('Capital Group (American Funds): private-company book · Vantage');
    rerender(<Page t={null} />);
    expect(document.title).toBe(DEFAULT_TITLE);
  });
});

describe('PageBoundary', () => {
  const Boom = (): null => {
    throw new Error('boom');
  };
  it('shows a way out when a page throws, and clears on the next page', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, rerender } = render(
      <PageBoundary path="/company/1">
        <Boom />
      </PageBoundary>
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('This page hit a problem');
    expect(container.querySelector('a[href="/"]')).not.toBeNull();
    expect(container.querySelector('button')?.textContent).toBe('Reload');
    rerender(
      <PageBoundary path="/firms">
        <p>firms page</p>
      </PageBoundary>
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('firms page');
    err.mockRestore();
  });
  it('renders the page untouched when nothing throws (no fallback, no console)', () => {
    const err = vi.spyOn(console, 'error');
    const { container } = render(
      <PageBoundary path="/">
        <p>market</p>
      </PageBoundary>
    );
    expect(container.textContent).toBe('market');
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
