import { useEffect, useState } from 'preact/hooks';
import { LocationProvider, Router, Route, lazy, ErrorBoundary, useLocation } from 'preact-iso';
import { useApi } from './api/client';
import type { Freshness } from './api/types';
import { CommandPalette } from './ui/CommandPalette';
import { density, themePref, type ThemePref } from './lib/prefs';
import { longDate } from './lib/format';

const Market = lazy(() => import('./pages/Market'));
const Company = lazy(() => import('./pages/Company'));
const Firms = lazy(() => import('./pages/Firms'));
const Firm = lazy(() => import('./pages/Firm'));
const Fund = lazy(() => import('./pages/Fund'));
const Activity = lazy(() => import('./pages/Activity'));
const NotFound = lazy(() => import('./pages/NotFound'));

const NAV: { href: string; label: string; match: (p: string) => boolean }[] = [
  { href: '/', label: 'Market', match: p => p === '/' },
  { href: '/activity', label: 'Activity', match: p => p.startsWith('/activity') },
  { href: '/firms', label: 'Firms', match: p => p.startsWith('/firm') },
];

function Sidebar() {
  const { path } = useLocation();
  return (
    <aside class="sidebar">
      <a class="brandmark" href="/" style={{ textDecoration: 'none' }}>
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="6" fill="#1a3557" />
          <path
            d="M7 22 L14 12 L19 18 L25 8"
            stroke="#e0b64a"
            stroke-width="2.6"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span>
          Vantage <small>v2</small>
        </span>
      </a>
      <nav class="nav" aria-label="Main">
        <div class="nav-section">Explore</div>
        {NAV.map(n => (
          <a key={n.href} href={n.href} aria-current={n.match(path) ? 'page' : undefined}>
            {n.label}
          </a>
        ))}
        <div class="nav-section">More</div>
        <a href="/legacy" target="_top">
          Legacy (v1 tabs)
        </a>
      </nav>
      <div class="sidebar-foot">Private holdings and marks from SEC N-PORT filings. Every number links its filing.</div>
    </aside>
  );
}

function MobileNav() {
  const { path } = useLocation();
  return (
    <nav class="mobile-nav" aria-label="Main">
      {NAV.map(n => (
        <a key={n.href} href={n.href} aria-current={n.match(path) ? 'page' : undefined}>
          {n.label}
        </a>
      ))}
    </nav>
  );
}

function Topbar({ onSearch }: { onSearch: () => void }) {
  const fresh = useApi<Freshness>('/api/freshness');
  const f = fresh.data;
  const cycle: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
  return (
    <header class="topbar">
      <button class="search-trigger" type="button" onClick={onSearch} aria-label="Search (⌘K)">
        <span aria-hidden="true">⌕</span>
        <span>Search companies, funds, firms…</span>
        <span class="spacer" />
        <kbd>⌘K</kbd>
      </button>
      <span class="spacer" />
      {f && (
        <span
          class="muted small hide-sm"
          title={`Bulk data through ${f.latestBulkQuarter}; catch-up through filings of ${f.newestFilingDate}; refresh #${f.refreshId}`}
        >
          Filings through {longDate(f.newestFilingDate)} · marks to {longDate(f.newestReportDate)}
        </span>
      )}
      <button
        class="btn sm ghost hide-sm"
        type="button"
        onClick={() => (density.value = density.value === 'compact' ? 'comfortable' : 'compact')}
        title="Row density"
      >
        {density.value === 'compact' ? 'Compact' : 'Comfortable'}
      </button>
      <button
        class="btn sm ghost hide-sm"
        type="button"
        onClick={() => (themePref.value = cycle[themePref.value])}
        title="Theme: system, light or dark"
      >
        Theme: {themePref.value}
      </button>
    </header>
  );
}

function Shell() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]');
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div class="shell">
      <Sidebar />
      <Topbar onSearch={() => setOpen(true)} />
      <main class="main" id="main">
        <div class="page">
          <ErrorBoundary>
            <Router>
              <Route path="/" component={Market} />
              <Route path="/company/:slug" component={Company} />
              <Route path="/name/:key" component={Company} />
              <Route path="/firms" component={Firms} />
              <Route path="/firm/:id" component={Firm} />
              <Route path="/fund/:key" component={Fund} />
              <Route path="/activity" component={Activity} />
              <Route default component={NotFound} />
            </Router>
          </ErrorBoundary>
        </div>
      </main>
      <MobileNav />
      <CommandPalette open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

export function App() {
  return (
    <LocationProvider>
      <Shell />
    </LocationProvider>
  );
}
