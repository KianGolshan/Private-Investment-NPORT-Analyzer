// Review 2026-10-15 accessibility: tabs name their panel, only the selected tab
// is in the Tab order, and the arrow keys, Home and End move along the set.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { TabPanel, Tabs } from '../src/ui/bits';

afterEach(cleanup);

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'holders', label: 'Holders' },
  { id: 'filings', label: 'Filings' },
];
function Page() {
  const [cur, setCur] = useState('overview');
  return (
    <>
      <Tabs id="t" tabs={TABS} current={cur} onSelect={setCur} />
      <TabPanel id="t" current={cur}>
        <p>{cur} content</p>
      </TabPanel>
    </>
  );
}

describe('Tabs and TabPanel', () => {
  it('link each tab to the panel and the panel to its tab', () => {
    const r = render(<Page />);
    const tabs = r.getAllByRole('tab');
    const panel = r.getByRole('tabpanel');
    for (const t of tabs) expect(t.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe('t-tab-overview');
    expect(tabs.map(t => t.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.click(tabs[1]!);
    expect(r.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('t-tab-holders');
    expect(r.getByRole('tabpanel').textContent).toBe('holders content');
  });
  it('move with the arrow keys (wrapping), Home and End, taking focus along', () => {
    const r = render(<Page />);
    const tab = (name: string) => r.getByRole('tab', { name });
    tab('Overview').focus();
    fireEvent.keyDown(tab('Overview'), { key: 'ArrowRight' });
    expect(tab('Holders').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('Holders'));
    fireEvent.keyDown(tab('Holders'), { key: 'End' });
    expect(tab('Filings').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tab('Filings'), { key: 'ArrowRight' });
    expect(tab('Overview').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tab('Overview'), { key: 'ArrowLeft' });
    expect(tab('Filings').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tab('Filings'), { key: 'Home' });
    expect(tab('Overview').getAttribute('aria-selected')).toBe('true');
    // other keys do nothing
    fireEvent.keyDown(tab('Overview'), { key: 'a' });
    expect(tab('Overview').getAttribute('aria-selected')).toBe('true');
  });
});
