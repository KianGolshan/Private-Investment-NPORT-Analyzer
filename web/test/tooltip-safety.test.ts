// Staff review F01: ECharts tooltip formatters return HTML (ECharts assigns it
// to innerHTML), so a company, fund or class name from a filing must be escaped
// before it meets markup. Guards every formatter string in the source.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../src/lib/format';

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : [];
  });

describe('tooltip HTML', () => {
  it('escapeHtml makes a hostile label inert text', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">&\'')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;'
    );
    expect(escapeHtml(null)).toBe('');
  });

  it('every name or label in an HTML tooltip string is escaped', () => {
    const unsafe: string[] = [];
    for (const f of files(join(__dirname, '../src')))
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!line.includes('<br/>')) return;
          for (const m of line.matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
            const expr = m[1]!.trim();
            if (
              /\b(name|label|seriesName|title|accession|registrant|instrument)\b/.test(expr) &&
              !/^escapeHtml\(/.test(expr)
            )
              unsafe.push(`${f}:${i + 1} \${${expr}}`);
          }
        });
    expect(unsafe).toEqual([]);
  });
});
