export default function NotFound() {
  return (
    <div class="empty">
      <div class="eyebrow">404</div>
      <h1>Page not found</h1>
      <p>
        There is no page at this address, or the company, fund or firm it named is no longer in the data. Search with{' '}
        <kbd>⌘K</kbd>, or start from the <a href="/">market overview</a>, <a href="/firms">firms</a> or{' '}
        <a href="/about">about the data</a>.
      </p>
    </div>
  );
}
