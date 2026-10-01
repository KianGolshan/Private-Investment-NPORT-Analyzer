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
