// Chart colors and fonts read from the CSS tokens (styles/tokens.css), so the
// charts follow light/dark and the palette lives in one place.

export interface ChartTheme {
  series: string[];
  text: string;
  text2: string;
  text3: string;
  border: string;
  surface: string;
  pos: string;
  neg: string;
  warn: string;
  accent: string;
  heat: [string, string];
  font: string;
}

export function readTheme(el: Element = document.documentElement): ChartTheme {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    series: [1, 2, 3, 4, 5, 6, 7, 8].map(i => v(`--series-${i}`, '#888')),
    text: v('--text', '#18212d'),
    text2: v('--text-2', '#4a5566'),
    text3: v('--text-3', '#7a8494'),
    border: v('--border', '#e2e6ec'),
    surface: v('--surface', '#fff'),
    pos: v('--pos', '#15803d'),
    neg: v('--neg', '#b91c1c'),
    warn: v('--warn', '#b45309'),
    accent: v('--accent', '#b8860b'),
    heat: [v('--heat-0', '#f1f5fb'), v('--heat-1', '#1f5fa8')],
    font: v('--font', 'sans-serif'),
  };
}

/** Axis, grid and tooltip defaults shared by every chart. */
export function baseOption(t: ChartTheme) {
  const axis = {
    axisLine: { lineStyle: { color: t.border } },
    axisTick: { lineStyle: { color: t.border } },
    axisLabel: { color: t.text3, fontSize: 11 },
    splitLine: { lineStyle: { color: t.border, type: 'dashed' as const } },
    nameTextStyle: { color: t.text3 },
  };
  return {
    color: t.series,
    textStyle: { fontFamily: t.font, color: t.text2 },
    aria: { enabled: true },
    animationDuration: 250,
    grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
    legend: {
      top: 0,
      left: 0,
      type: 'scroll' as const,
      textStyle: { color: t.text2, fontSize: 12 },
      icon: 'roundRect',
    },
    tooltip: {
      trigger: 'axis' as const,
      backgroundColor: t.surface,
      borderColor: t.border,
      textStyle: { color: t.text, fontSize: 12 },
      confine: true,
    },
    xAxisDefaults: axis,
    yAxisDefaults: axis,
  };
}
