// Exports. One column definition drives a table on screen and its CSV/XLSX, so
// the file always matches what the analyst sees. Numbers stay numbers in XLSX.
// Every exported row carries its mark date and accession (the columns that
// show them on screen are exported too).

export interface ExportColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

const fileSafe = (s: string) =>
  s
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);

// Text a spreadsheet would read as a formula (it starts with = + - @, a tab or
// a carriage return, and is not a plain number) gets a leading apostrophe, so a
// name from a filing opens as text (staff review F09). Numbers stay numbers;
// XLSX writes typed cells (strings are never formulas there).
const FORMULA = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?[\d,]*\.?\d+(?:[eE][-+]?\d+)?%?$/;
export function csvText(v: unknown): string {
  const s = v == null ? '' : String(v);
  return typeof v === 'string' && FORMULA.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s;
}

function cell(v: unknown): string {
  const s = csvText(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(columns: ExportColumn<T>[], rows: T[]): string {
  return [columns.map(c => cell(c.header)).join(','), ...rows.map(r => columns.map(c => cell(c.value(r))).join(','))]
    .join('\n')
    .concat('\n');
}

export function download(data: BlobPart, type: string, name: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportCsv<T>(name: string, columns: ExportColumn<T>[], rows: T[]): void {
  download(toCsv(columns, rows), 'text/csv;charset=utf-8', `${fileSafe(name)}.csv`);
}

/**
 * What a file is and where it came from, as label/value pairs (review 2026-10-15
 * N8). XLSX puts them on a second sheet; a CSV stays one plain table so it opens
 * in any tool, and carries the data version in its Source column instead.
 */
export function aboutRows(p: {
  title: string;
  page: string;
  source: string;
  basis?: string;
  exportedAt?: Date;
}): [string, string][] {
  return [
    ['Export', p.title],
    ['Page', p.page],
    ['Exported', (p.exportedAt ?? new Date()).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'],
    ...(p.source ? ([['Data version', p.source]] as [string, string][]) : []),
    ...(p.basis ? ([['How history is read', p.basis]] as [string, string][]) : []),
    [
      'Note',
      'From public SEC filings (Form N-PORT), as the funds report them; each row has its mark date and filing. Not investment advice: check the linked filing before relying on any number.',
    ],
  ];
}

/** XLSX through SheetJS, loaded only when the analyst asks for it. */
export async function exportXlsx<T>(
  name: string,
  columns: ExportColumn<T>[],
  rows: T[],
  about?: [string, string][]
): Promise<void> {
  const XLSX = await import('xlsx');
  const aoa = [columns.map(c => c.header), ...rows.map(r => columns.map(c => c.value(r) ?? null))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  // Excel sheet names: 31 chars, none of []:*?/\
  XLSX.utils.book_append_sheet(wb, ws, name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet1');
  if (about?.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(about), 'About this export');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  download(out, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `${fileSafe(name)}.xlsx`);
}
