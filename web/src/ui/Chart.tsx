import { useEffect, useRef, useState } from 'preact/hooks';
import type { EChartsCoreOption, ECharts } from 'echarts/core';
import { effectiveTheme } from '../lib/prefs';
import { readTheme, type ChartTheme } from './theme';

// A chart. ECharts loads on first use (a lazy chunk), reads its colors from
// the CSS tokens, resizes with its box, and redraws when the theme changes.
// Every chart on a page has a table twin (the page's DataTable), so nothing
// is shown only as a picture.

type Handler = (params: unknown, chart: ECharts) => void;

// A failed load (a dropped connection, a deploy that replaced the chunk) is
// forgotten, so Retry loads it again (staff review F18).
let loader: Promise<typeof import('./echarts')> | null = null;
// ECharts (~650 KB) starts loading once the page has loaded and the browser is
// idle, so the page's text and tables paint first (W5 perf pass: it was on the
// largest-paint path of Market and Explore); the chart box holds its height.
const afterFirstPaint = () =>
  new Promise<void>(resolve => {
    const idle = () =>
      'requestIdleCallback' in window
        ? (window as Window & typeof globalThis).requestIdleCallback(() => resolve(), { timeout: 1500 })
        : setTimeout(resolve, 1);
    if (document.readyState === 'complete') idle();
    else window.addEventListener('load', idle, { once: true });
  });
const loadEcharts = () =>
  (loader ??= afterFirstPaint()
    .then(() => import('./echarts'))
    .catch(err => {
      loader = null;
      throw err;
    }));

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
  const [attempt, setAttempt] = useState(0);
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
      e => {
        if (!disposed) setFailed(String(e?.message || e));
      }
    );
    return () => {
      disposed = true;
      ro?.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, [attempt]);

  useEffect(() => {
    if (failed) return undefined; // nothing to draw into: no polling while the load has failed
    let cancelled = false;
    const draw = () => {
      if (cancelled) return;
      const c = chart.current;
      if (!c) {
        // ECharts still loading: try again on the next frame (a failed load
        // re-runs this effect with `failed` set, which cancels this loop)
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
  }, [build, theme, on, failed]);

  if (failed)
    return (
      <div class="notice error" role="alert">
        Chart failed to load: {failed}. The table below has the same numbers.{' '}
        <button
          class="btn sm"
          type="button"
          onClick={() => {
            setFailed(null);
            setAttempt(a => a + 1);
          }}
        >
          Retry
        </button>
      </div>
    );
  return <div ref={el} class="chart" style={{ height: `${height}px` }} role="img" aria-label={label} />;
}
