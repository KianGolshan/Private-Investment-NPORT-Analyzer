// The ECharts build the app uses: only the charts and components it draws, so
// the lazy chunk stays small. Loaded on first chart (ui/Chart.tsx).
import * as echarts from 'echarts/core';
import { BarChart, LineChart, HeatmapChart, ScatterChart, CustomChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkPointComponent,
  VisualMapComponent,
  AriaComponent,
  TitleComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  HeatmapChart,
  ScatterChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkPointComponent,
  VisualMapComponent,
  AriaComponent,
  TitleComponent,
  CanvasRenderer,
]);

export { echarts };
