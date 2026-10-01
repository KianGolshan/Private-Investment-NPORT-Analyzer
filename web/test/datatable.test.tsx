import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/preact';
import { DataTable } from '../src/ui/DataTable';

interface R {
  name: string;
  value: number | null;
}
const rows: R[] = [
  { name: 'Stripe', value: 2_496_860_337 },
  { name: 'Anthropic', value: 17_294_813_377 },
  { name: 'Unknown', value: null },
];
const columns = [
  { id: 'name', header: 'Company', value: (r: R) => r.name },
  { id: 'value', header: 'Value', value: (r: R) => r.value, num: true },
];

const names = (c: Element) => [...c.querySelectorAll('tbody tr')].map(tr => tr.querySelector('td')?.textContent);

describe('DataTable', () => {
  it('sorts by a column, blanks last both ways', () => {
    const { container, getByText } = render(
      <DataTable columns={columns} rows={rows} rowKey={r => r.name} sort={{ id: 'value', desc: true }} />
    );
    expect(names(container)).toEqual(['Anthropic', 'Stripe', 'Unknown']);
    fireEvent.click(getByText('Value'));
    expect(names(container)).toEqual(['Stripe', 'Anthropic', 'Unknown']);
  });
  it('filters rows on any column and counts them', () => {
    const { container, getByLabelText, getByText } = render(
      <DataTable columns={columns} rows={rows} rowKey={r => r.name} filterPlaceholder="Filter" />
    );
    fireEvent.input(getByLabelText('Filter rows'), { target: { value: 'strip' } });
    expect(names(container)).toEqual(['Stripe']);
    expect(getByText('1 row')).toBeTruthy();
  });
  it('groups rows under a header', () => {
    const { container } = render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={r => r.name}
        group={{ key: r => (r.value ? 'held' : 'none'), header: k => <b>{k}</b> }}
      />
    );
    expect([...container.querySelectorAll('tr.group')].map(g => g.textContent)).toEqual(['held', 'none']);
  });
});
