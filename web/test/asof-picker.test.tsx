// Review 2026-10-15 N3: the as-of control says "latest" instead of showing an
// empty date field, opens a field on request, and "Latest" clears a picked date.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { AsOfPicker } from '../src/scope/ScopeBar';

afterEach(cleanup);

describe('AsOfPicker', () => {
  it('shows "As of: latest" with no empty field, then a date field on click', () => {
    const onChange = vi.fn();
    const r = render(<AsOfPicker value="" newest="2026-07-31" max="2026-07-31" onChange={onChange} />);
    expect(r.container.querySelector('input[type="date"]')).toBeNull();
    const btn = r.getByRole('button', { name: 'As of: latest' });
    expect(btn.getAttribute('title')).toContain('Jul 31, 2026');
    fireEvent.click(btn);
    const field = r.getByLabelText('As of date') as HTMLInputElement;
    expect(field.value).toBe('');
    expect(field.max).toBe('2026-07-31');
    fireEvent.change(field, { target: { value: '2025-12-31' } });
    expect(onChange).toHaveBeenLastCalledWith('2025-12-31');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
  it('a picked date shows the field and a Latest button that clears it', () => {
    const onChange = vi.fn();
    const r = render(<AsOfPicker value="2025-12-31" newest="2026-07-31" max="2026-07-31" onChange={onChange} />);
    expect((r.getByLabelText('As of date') as HTMLInputElement).value).toBe('2025-12-31');
    fireEvent.click(r.getByRole('button', { name: 'Latest' }));
    expect(onChange).toHaveBeenLastCalledWith('');
    // once cleared (the parent passes the empty value back), the compact button returns
    r.rerender(<AsOfPicker value="" newest="2026-07-31" max="2026-07-31" onChange={onChange} />);
    expect(r.getByRole('button', { name: 'As of: latest' })).toBeTruthy();
  });
  it('without a newest date it still works and has no tooltip', () => {
    const r = render(<AsOfPicker value="" newest={null} max={undefined} onChange={() => {}} />);
    expect(r.getByRole('button', { name: 'As of: latest' }).getAttribute('title')).toBeNull();
  });
});
