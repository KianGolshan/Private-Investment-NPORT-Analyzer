import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  type VirtualizerOptions,
} from '@tanstack/virtual-core';
import { exportCsv, exportXlsx, type ExportColumn } from '../lib/export';
import type { Envelope } from '../api/types';

// The one table: sortable, groupable, filterable, virtualized when long, and
// exportable from the same column definitions (the file matches the screen).

export interface Column<T> {
  id: string;
  header: string;
  /** Raw value: used to sort and to export. */
  value: (row: T) => string | number | boolean | null | undefined;
  /** What the cell shows (defaults to the raw value). */
  render?: (row: T) => ComponentChildren;
  /**
   * A value withheld for this row (e.g. returns without usable lots): the cell shows "—" and the export
   * writes nothing, so screen and file never disagree (Codex verification V08, LESSONS 39).
   */
  hidden?: (row: T) => boolean;
  num?: boolean;
  /** Extra export-only columns (e.g. accession beside a linked date). */
  exportAs?: ExportColumn<T>[];
  noExport?: boolean;
  noSort?: boolean;
  wrap?: boolean;
  width?: string;
  title?: string;
}

export interface Group<T> {
  key: (row: T) => string;
  header: (key: string, rows: T[]) => ComponentChildren;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, i: number) => string;
  sort?: { id: string; desc?: boolean };
  group?: Group<T>;
  /** The total row, computed from the rows shown (after the filter box). */
  totals?: (rows: T[]) => Partial<Record<string, ComponentChildren>>;
  exportName?: string;
  /** Written as a last "Basis" column in the export: how the numbers read history (F14). */
  basis?: string;
  /** The answer the rows came from: its generation and curation label the export (Codex verification V07). */
  source?: Pick<Envelope, 'refreshId' | 'basis'> | null;
  filterPlaceholder?: string;
  maxHeight?: number;
  onRowClick?: (row: T) => void;
  empty?: ComponentChildren;
  caption?: string;
  toolbar?: ComponentChildren;
}

const VIRTUAL_MIN = 200;

function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // blanks last either way
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

// "generation 29, curation sha256 <full digest>" for an answer, or '' without one.
export function sourceOf(a: Pick<Envelope, 'refreshId' | 'basis'> | null | undefined): string {
  if (!a) return '';
  const gen = a.basis?.generation ?? a.refreshId;
  const parts = [gen != null ? `generation ${gen}` : ''];
  if (a.basis?.curationDigest) parts.push(`curation sha256 ${a.basis.curationDigest}`);
  else if (a.basis?.curationRev) parts.push(`curation ${a.basis.curationRev}`);
  return parts.filter(Boolean).join(', ');
}

export function DataTable<T>(p: Props<T>) {
  const [sort, setSort] = useState(p.sort ?? null);
  const [filter, setFilter] = useState('');

  const rows = useMemo(() => {
    let out = p.rows;
    const q = filter.trim().toLowerCase();
    if (q) {
      out = out.filter(r =>
        p.columns.some(c => {
          const v = c.value(r);
          return v != null && String(v).toLowerCase().includes(q);
        })
      );
    }
    if (sort) {
      const col = p.columns.find(c => c.id === sort.id);
      if (col) {
        out = [...out].sort((a, b) => {
          const va = col.value(a);
          const vb = col.value(b);
          if (va == null || vb == null) return compare(va, vb);
          const d = compare(va, vb);
          return sort.desc ? -d : d;
        });
      }
    }
    return out;
  }, [p.rows, p.columns, sort, filter]);

  // From the rows' own answer, never a separate "latest" fetch (LESSONS 39).
  const source = sourceOf(p.source);
  const exportCols = useMemo(
    () => [
      ...p.columns.flatMap(c =>
        c.noExport
          ? []
          : [
              {
                header: c.header,
                value: c.hidden ? (r: T) => (c.hidden!(r) ? null : c.value(r)) : c.value,
              } as ExportColumn<T>,
              ...(c.exportAs ?? []),
            ]
      ),
      ...(p.basis
        ? [
            { header: 'Basis', value: () => p.basis } as ExportColumn<T>,
            // the generation and the exact reviewed files behind the rows (review R18)
            ...(source ? [{ header: 'Source', value: () => source } as ExportColumn<T>] : []),
          ]
        : []),
    ],
    [p.columns, p.basis, source]
  );

  const groups = useMemo(() => {
    if (!p.group) return null;
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const k = p.group.key(r);
      const list = m.get(k);
      if (list) list.push(r);
      else m.set(k, [r]);
    }
    return [...m.entries()];
  }, [rows, p.group]);

  const onSort = (c: Column<T>) => {
    if (c.noSort) return;
    setSort(s => (s?.id === c.id ? { id: c.id, desc: !s.desc } : { id: c.id, desc: !!c.num }));
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = !groups && rows.length >= VIRTUAL_MIN && !!p.maxHeight;
  const v = useVirtual(scrollRef, virtual ? rows.length : 0);

  const head = (
    <thead>
      <tr>
        {p.columns.map(c => {
          const dir = sort?.id === c.id ? (sort.desc ? 'descending' : 'ascending') : 'none';
          return (
            <th key={c.id} class={c.num ? 'num' : ''} style={c.width ? { width: c.width } : undefined} aria-sort={dir}>
              {c.noSort ? (
                c.header
              ) : (
                <button type="button" onClick={() => onSort(c)} title={c.title || `Sort by ${c.header}`}>
                  {c.header}
                  <span aria-hidden="true" class="muted">
                    {dir === 'ascending' ? '▲' : dir === 'descending' ? '▼' : ''}
                  </span>
                </button>
              )}
            </th>
          );
        })}
      </tr>
    </thead>
  );

  const rowEl = (r: T, i: number) => (
    <tr
      key={p.rowKey(r, i)}
      onClick={p.onRowClick ? () => p.onRowClick!(r) : undefined}
      // a row that opens something opens from the keyboard too (F18)
      tabIndex={p.onRowClick ? 0 : undefined}
      onKeyDown={
        p.onRowClick
          ? (e: KeyboardEvent) => {
              if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
              e.preventDefault();
              p.onRowClick!(r);
            }
          : undefined
      }
      style={p.onRowClick ? { cursor: 'pointer' } : undefined}
    >
      {p.columns.map(c => (
        <td key={c.id} class={c.num ? 'num' : c.wrap ? 'wrap' : ''}>
          {c.hidden?.(r) ? '—' : c.render ? c.render(r) : (c.value(r) ?? '—')}
        </td>
      ))}
    </tr>
  );

  let body: ComponentChildren;
  if (groups) {
    body = groups.map(([k, list]) => [
      <tr class="group" key={`g:${k}`}>
        <td colSpan={p.columns.length}>{p.group!.header(k, list)}</td>
      </tr>,
      ...list.map((r, i) => rowEl(r, i)),
    ]);
  } else if (virtual) {
    const items = v.items;
    const top = items[0]?.start ?? 0;
    const bottom = v.total - (items[items.length - 1]?.end ?? 0);
    body = [
      top > 0 && <tr key="pad-top" style={{ height: `${top}px` }} aria-hidden="true" />,
      ...items.map(it => rowEl(rows[it.index]!, it.index)),
      bottom > 0 && <tr key="pad-bottom" style={{ height: `${bottom}px` }} aria-hidden="true" />,
    ];
  } else {
    body = rows.map(rowEl);
  }

  const totals = p.totals?.(rows);
  const showToolbar = p.exportName || p.filterPlaceholder || p.toolbar;
  return (
    <div>
      {showToolbar && (
        <div class="row wrap" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
          {p.filterPlaceholder && (
            <input
              class="input"
              type="search"
              placeholder={p.filterPlaceholder}
              value={filter}
              onInput={e => setFilter((e.target as HTMLInputElement).value)}
              aria-label="Filter rows"
              style={{ width: '220px' }}
            />
          )}
          {p.toolbar}
          <span class="spacer" />
          <span class="muted small">
            {rows.length.toLocaleString()} {rows.length === 1 ? 'row' : 'rows'}
          </span>
          {p.exportName && (
            <>
              <button class="btn sm" type="button" onClick={() => exportCsv(p.exportName!, exportCols, rows)}>
                CSV
              </button>
              <button class="btn sm" type="button" onClick={() => void exportXlsx(p.exportName!, exportCols, rows)}>
                XLSX
              </button>
            </>
          )}
        </div>
      )}
      <div
        class="table-wrap"
        ref={scrollRef}
        style={p.maxHeight ? ({ '--table-max-h': `${p.maxHeight}px` } as Record<string, string>) : undefined}
      >
        <table class="data">
          {p.caption && <caption class="sr-only">{p.caption}</caption>}
          {head}
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={p.columns.length} class="empty">
                  {p.empty ?? 'Nothing to show.'}
                </td>
              </tr>
            ) : (
              body
            )}
          </tbody>
          {p.totals && rows.length > 0 && (
            <tfoot>
              <tr class="total">
                {p.columns.map(c => (
                  <td key={c.id} class={c.num ? 'num' : ''}>
                    {totals?.[c.id] ?? ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

/** Row windowing for long tables (TanStack Virtual core, no framework adapter needed). */
function useVirtual(ref: { current: HTMLDivElement | null }, count: number) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [virtualizer] = useState(
    () =>
      new Virtualizer<HTMLDivElement, Element>({
        count,
        getScrollElement: () => ref.current,
        estimateSize: () => 33,
        overscan: 12,
        scrollToFn: elementScroll,
        observeElementRect,
        observeElementOffset,
        onChange: () => rerender(0),
      } as VirtualizerOptions<HTMLDivElement, Element>)
  );
  virtualizer.setOptions({ ...virtualizer.options, count });
  useLayoutEffect(() => virtualizer._didMount(), [virtualizer]);
  useEffect(() => {
    virtualizer._willUpdate();
  });
  return {
    items: count ? virtualizer.getVirtualItems() : [],
    total: count ? virtualizer.getTotalSize() : 0,
  };
}
