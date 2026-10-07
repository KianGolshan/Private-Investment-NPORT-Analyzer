// Codex verification V07/V08 (LESSONS 39): an export says what the screen says.
// A value hidden on screen exports empty, and the Source column names the
// generation and curation of the answer the rows came from, never a separately
// fetched "latest" one.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/preact';
import { DataTable } from '../src/ui/DataTable';
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
});
