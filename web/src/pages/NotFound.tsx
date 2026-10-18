import { PAGE_TITLES, usePageTitle } from '../lib/title';

export default function NotFound() {
  usePageTitle(PAGE_TITLES.notFound);
  return (
    <div class="empty">
      <div class="eyebrow">404</div>
      <h1>Page not found</h1>
      <p>
        There is no page at this address, or the company, fund or firm it named is no longer in the data. Search with{' '}
        <kbd>⌘K</kbd>, or start from the <a href="/">market overview</a>, <a href="/firms">firms</a> or{' '}
        <a href="/about">About Vantage</a>.
      </p>
    </div>
  );
}
