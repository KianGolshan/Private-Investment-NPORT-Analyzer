import { effect, signal } from '@preact/signals';

// Per-viewer display preferences (theme, density). Kept in localStorage as a
// convenience only; the app works the same without it.

export type ThemePref = 'system' | 'light' | 'dark';
export type Density = 'comfortable' | 'compact';

function load<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    // storage blocked (private mode): the preference lasts for this page only
  }
}

export const themePref = signal<ThemePref>(load('vantage.theme', ['system', 'light', 'dark'] as const, 'system'));
export const density = signal<Density>(load('vantage.density', ['comfortable', 'compact'] as const, 'comfortable'));

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const systemDark = signal(!!media?.matches);
media?.addEventListener?.('change', e => (systemDark.value = e.matches));

/** The theme actually shown; charts re-read the tokens when it changes. */
export const effectiveTheme = signal<'light' | 'dark'>('light');

effect(() => {
  const root = document.documentElement;
  const pref = themePref.value;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
  effectiveTheme.value = pref === 'system' ? (systemDark.value ? 'dark' : 'light') : pref;
  save('vantage.theme', pref);
});
effect(() => {
  document.documentElement.setAttribute('data-density', density.value);
  save('vantage.density', density.value);
});
