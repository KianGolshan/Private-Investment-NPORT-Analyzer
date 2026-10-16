// Codex verification V07/V08 (LESSONS 39): an export says what the screen says.
// A value hidden on screen exports empty, and the Source column names the
// generation and curation of the answer the rows came from, never a separately
// fetched "latest" one.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { DataTable } from '../src/ui/DataTable';
import { aboutRows } from '../src/lib/export';
import { clearApiCache } from '../src/api/client';

interface R {
  name: string;
  irr: number | null;
  ok: boolean;
}
const rows: R[] = [
  { name: 'Usable lots', irr: 0.12, ok: true },
  { name: 'No usable lots', irr: 0.55, ok: false },
];

let blobs: Blob[] = [];
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearApiCache();
  blobs = [];
});
function captureDownloads() {
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (b: Blob) => {
      blobs.push(b);
      return 'blob:test';
    },
    revokeObjectURL: () => {},
  });
}

describe('DataTable export provenance and parity', () => {
  it('a hidden value shows "—" and exports empty; the source is the rows’ own answer', async () => {
    captureDownloads();
    // a freshness answer that names a NEWER generation than the rows: must not be used
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ refreshId: 30, generation: { id: 30, curationDigest: 'f'.repeat(64) } }),
      }))
    );
    const digest = 'a'.repeat(64);
    const { container, getByText } = render(
      <DataTable<R>
        columns={[
          { id: 'name', header: 'Position', value: r => r.name },
          { id: 'irr', header: 'IRR', value: r => r.irr, num: true, hidden: r => !r.ok },
        ]}
        rows={rows}
        rowKey={r => r.name}
        exportName="probe"
        basis="Basis text"
        source={{
          refreshId: 29,
          basis: { generation: 29, curationRev: null, curationDigest: digest, companies: '', firms: '' },
        }}
      />
    );
    const cells = [...container.querySelectorAll('tbody tr')].map(tr => tr.textContent);
    expect(cells.find(t => t?.startsWith('No usable lots'))).toContain('—');
    fireEvent.click(getByText('CSV'));
    await waitFor(() => expect(blobs.length).toBe(1));
    const csv = await blobs[0]!.text();
    const [head, ...lines] = csv.trim().split(/\r?\n/);
    expect(head).toBe('Position,IRR,Basis,Source');
    expect(lines.find(l => l.startsWith('No usable lots'))).toMatch(/^No usable lots,,/);
    expect(lines.find(l => l.startsWith('Usable lots'))).toMatch(/^Usable lots,0\.12,/);
    expect(csv).toContain(`generation 29, curation sha256 ${digest}`);
    expect(csv).not.toContain('generation 30');
  });

  it('every export names its data version, with or without a method note, also with no rows (review 2026-10-15 N8)', async () => {
    captureDownloads();
    const src = {
      refreshId: 41,
      basis: { generation: 41, curationRev: null, curationDigest: 'b'.repeat(64), companies: '', firms: '' },
    };
    const cols = [{ id: 'name', header: 'Position', value: (r: R) => r.name }];
    // a company-page table: no Basis column, but the Source still travels with the rows
    const one = render(
      <DataTable<R> columns={cols} rows={rows} rowKey={r => r.name} exportName="Anthropic-holders" source={src} />
    );
    fireEvent.click(one.getByText('CSV'));
    await waitFor(() => expect(blobs.length).toBe(1));
    const csv = await blobs[0]!.text();
    expect(csv.split(/\r?\n/)[0]).toBe('Position,Source');
    expect(csv).toContain('generation 41, curation sha256 ' + 'b'.repeat(64));
    // the button says which table it downloads
    expect(one.getByText('CSV').getAttribute('aria-label')).toBe('Download Anthropic holders as CSV');
    one.unmount();
    // header only: an empty table still says what it is
    const empty = render(
      <DataTable<R> columns={cols} rows={[]} rowKey={r => r.name} exportName="empty" source={src} />
    );
    fireEvent.click(empty.getByText('CSV'));
    await waitFor(() => expect(blobs.length).toBe(2));
    expect((await blobs[1]!.text()).trim()).toBe('Position,Source');
    empty.unmount();
    // no answer behind the rows: no Source column rather than a made-up one
    const none = render(<DataTable<R> columns={cols} rows={rows} rowKey={r => r.name} exportName="plain" />);
    fireEvent.click(none.getByText('CSV'));
    await waitFor(() => expect(blobs.length).toBe(3));
    expect((await blobs[2]!.text()).split(/\r?\n/)[0]).toBe('Position');
  });

  it('the XLSX "About this export" sheet: title, page, time, data version, method, disclaimer', () => {
    const at = new Date('2026-10-15T21:30:00Z');
    const rows2 = aboutRows({
      title: 'probe',
      page: 'https://x.test/company/1',
      source: 'generation 41',
      basis: 'B',
      exportedAt: at,
    });
    expect(rows2.map(r => r[0])).toEqual(['Export', 'Page', 'Exported', 'Data version', 'How history is read', 'Note']);
    expect(rows2[2]![1]).toBe('2026-10-15 21:30 UTC');
    expect(rows2.at(-1)![1]).toContain('Not investment advice');
    // without a source or basis those lines are left out, never filled in
    expect(aboutRows({ title: 't', page: 'p', source: '', exportedAt: at }).map(r => r[0])).toEqual([
      'Export',
      'Page',
      'Exported',
      'Note',
    ]);
  });
});
