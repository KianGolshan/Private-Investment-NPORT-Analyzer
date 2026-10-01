import { useEffect, useRef, useState } from 'preact/hooks';
import type { EChartsCoreOption, ECharts } from 'echarts/core';
import { effectiveTheme } from '../lib/prefs';
import { readTheme, type ChartTheme } from './theme';

// A chart. ECharts loads on first use (a lazy chunk), reads its colors from
// the CSS tokens, resizes with its box, and redraws when the theme changes.
// Every chart on a page has a table twin (the page's DataTable), so nothing
// is shown only as a picture.

type Handler = (params: unknown, chart: ECharts) => void;

let loader: Promise<typeof import('./echarts')> | null = null;
const loadEcharts = () => (loader ??= import('./echarts'));

export function Chart({
  build,
  height = 320,
  label,
  on,
}: {
  build: (t: ChartTheme) => EChartsCoreOption;
  height?: number;
  label: string;
  on?: Record<string, Handler>;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const theme = effectiveTheme.value;

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    loadEcharts().then(
      ({ echarts }) => {
        if (disposed || !el.current) return;
        const c = echarts.init(el.current, undefined, { renderer: 'canvas' });
        chart.current = c;
        ro = new ResizeObserver(() => c.resize());
        ro.observe(el.current);
      },
      e => setFailed(String(e?.message || e))
    );
    return () => {
      disposed = true;
      ro?.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const draw = () => {
      if (cancelled) return;
      const c = chart.current;
      if (!c) {
        // ECharts still loading: try again on the next frame
        requestAnimationFrame(draw);
        return;
      }
      c.setOption(build(readTheme()), { notMerge: true });
      c.off('click');
      c.off('datazoom');
      for (const [ev, fn] of Object.entries(on ?? {})) {
        c.off(ev);
        c.on(ev, (params: unknown) => fn(params, c));
      }
    };
    draw();
    return () => {
      cancelled = true;
    };
  }, [build, theme, on]);

  if (failed) return <div class="notice error">Chart failed to load: {failed}</div>;
  return <div ref={el} class="chart" style={{ height: `${height}px` }} role="img" aria-label={label} />;
}
