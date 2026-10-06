import { describe, expect, it } from 'vitest';
import { edgarUrl, moneyC, moneyDelta, pct, price, share, slugOf } from '../src/lib/format';
import { toCsv } from '../src/lib/export';

describe('format', () => {
  it('compact and signed money', () => {
    expect(moneyC(5_930_000_000)).toBe('$5.93B');
    expect(moneyC(-2_100_000)).toBe('−$2.1M');
    expect(moneyDelta(150_000_000)).toBe('+$150.0M');
    expect(moneyDelta(0)).toBe('$0');
    expect(moneyC(null)).toBe('—');
  });
  it('per-share only for share rows (trap 40)', () => {
    expect(price(63, 'NS')).toBe('$63.00/sh');
    expect(price(4115.38, 'OU')).toBe('$4,115.38/unit');
  });
  it('percent and share of a whole', () => {
    expect(pct(5.76)).toBe('+5.8%');
    expect(pct(-15.3)).toBe('−15.3%');
    expect(share(0.0611716221)).toBe('6.12%');
  });
  it('EDGAR links strip leading zeros and dashes', () => {
    expect(edgarUrl('0000044201', '0001193125-26-323081')).toBe(
      'https://www.sec.gov/Archives/edgar/data/44201/000119312526323081/0001193125-26-323081-index.htm'
    );
    expect(edgarUrl(null, 'x')).toBeNull();
  });
  it('slugs and CSV quoting', () => {
    expect(slugOf('FHU US Holdings (Chobani)')).toBe('fhu-us-holdings-chobani');
    const csv = toCsv([{ header: 'Name', value: (r: { n: string }) => r.n }], [{ n: 'a, "b"' }]);
    expect(csv).toBe('Name\n"a, ""b"""\n');
  });
});

describe('CSV formula safety (F09)', () => {
  type R = { v: string | number | null };
  const col = [{ header: 'V', value: (r: R) => r.v }];
  const cells = (vs: R['v'][]) =>
    toCsv(
      col,
      vs.map(v => ({ v }))
    )
      .split('\n')
      .slice(1, -1);
  it('text a spreadsheet would run as a formula opens as text', () => {
    expect(cells(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', 'Stripe, Inc.'])).toEqual([
      "'=1+1",
      "'+SUM(A1)",
      "'-2+3",
      "'@cmd",
      "'\tx",
      '"Stripe, Inc."',
    ]);
  });
  it('numbers, signed numeric text and blanks are unchanged', () => {
    expect(cells([-30167925.75, '-12.5', '-1,234', '+4%', 0, null])).toEqual([
      '-30167925.75',
      '-12.5',
      '"-1,234"',
      '+4%',
      '0',
      '',
    ]);
  });
});
