import { useEffect, useState } from 'preact/hooks';
import { LocationProvider, Router, Route, lazy, ErrorBoundary, useLocation } from 'preact-iso';
import { useApi } from './api/client';
import type { Freshness } from './api/types';
import { CommandPalette } from './ui/CommandPalette';
import { density, themePref, type ThemePref } from './lib/prefs';
import { longDate } from './lib/format';

const Market = lazy(() => import('./pages/Market'));
const Company = lazy(() => import('./pages/company'));
const Firms = lazy(() => import('./pages/Firms'));
const Firm = lazy(() => import('./pages/firm'));
const Fund = lazy(() => import('./pages/fund'));
const Activity = lazy(() => import('./pages/Activity'));
const Explore = lazy(() => import('./pages/Explore'));
const Tracked = lazy(() => import('./pages/Tracked'));
const Compare = lazy(() => import('./pages/Compare'));
const NotFound = lazy(() => import('./pages/NotFound'));

const NAV: { href: string; label: string; match: (p: string) => boolean }[] = [
  { href: '/explore', label: 'Explore', match: p => p.startsWith('/explore') },
  { href: '/', label: 'Market', match: p => p === '/' },
  { href: '/activity', label: 'Activity', match: p => p.startsWith('/activity') },
  { href: '/tracked', label: 'Tracked', match: p => p.startsWith('/tracked') },
  { href: '/compare', label: 'Compare', match: p => p.startsWith('/compare') },
  { href: '/firms', label: 'Firms', match: p => p.startsWith('/firm') },
];

// /api/config: the public site (P9) has no v1 page; the link shows only when
// the server says it is there.
interface Config {
  public: boolean;
  build: string;
}

function Sidebar() {
  const { path } = useLocation();
  const config = useApi<Config>('/api/config').data;
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
        {config && !config.public && (
          <>
            <div class="nav-section">More</div>
            <a href="/legacy" target="_top">
              Private Credit (v1)
            </a>
          </>
        )}
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

// The last warehouse job, when it needs attention (Codex verification V05): the
// data version alone cannot show a running, failed or warning job. A job whose
// process ended mid-run is 'interrupted' (lib/warehouse/job-state.js).
function JobPill({ job }: { job: Freshness['job'] }) {
  if (!job) return null;
  const [tone, text, title] =
    job.status === 'running'
      ? ['info', 'Job running', `${job.kind} started ${job.startedAt}`]
      : job.status === 'failed' || job.status === 'interrupted'
        ? [
            'neg',
            job.status === 'failed' ? 'Last job failed' : 'Last job interrupted',
            `${job.kind}: ${job.error ?? job.status}; the data shown is the last published generation`,
          ]
        : job.warning
          ? ['warn', 'Published with warnings', `${job.kind}: ${job.warning}`]
          : [null, null, null];
  if (!tone) return null;
  return (
    <span class={`badge ${tone}`} role="status" title={title ?? undefined}>
      {text}
    </span>
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
      <JobPill job={f?.job} />
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
              <Route path="/explore" component={Explore} />
              <Route path="/tracked" component={Tracked} />
              <Route path="/compare" component={Compare} />
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
