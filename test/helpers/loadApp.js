// Loads the REAL public/index.html + public/app.js into a jsdom window via
// Node's vm module, so Fund X-Ray's browser-only functions (which read/write
// the DOM directly and are not otherwise exported/module-wrapped) can be
// exercised exactly as they run in production — same markup, same code, no
// re-implementation of the UI logic under test.
//
// CDN <script src> tags (Chart.js, SheetJS, jsPDF — unused by Fund X-Ray) and
// the trailing <script src="app.js"> are stripped from the HTML before
// parsing (jsdom would otherwise try to fetch them over the network, which
// this suite must not depend on); app.js is then evaluated directly against
// the window so its global function declarations (searchFundXray,
// populateTopFundsDropdown, etc.) and state (TOP_FUND_GROUPS, xrayFilings,
// ...) become properties of that same window/context.
const { JSDOM } = require('jsdom');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const rawHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const appJsSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const viewsSource = fs.readFileSync(path.join(ROOT, 'public', 'views.js'), 'utf8');
const splitsSource = fs.readFileSync(path.join(ROOT, 'public', 'splits.js'), 'utf8');
const peerSource = fs.readFileSync(path.join(ROOT, 'lib', 'analytics', 'peer.js'), 'utf8');
const fundGroupsSource = fs.readFileSync(path.join(ROOT, 'public', 'fund-groups.js'), 'utf8');

const htmlWithoutScripts = rawHtml
  .replace(/<script src="https:\/\/[^"]*"><\/script>\s*/g, '')
  .replace(/<script src="\/?splits\.js"><\/script>\s*/g, '')
  .replace(/<script src="\/?peer\.js"><\/script>\s*/g, '')
  .replace(/<script src="\/?fund-groups\.js"><\/script>\s*/g, '')
  .replace(/<script src="\/?app\.js"><\/script>\s*/g, '');

// Builds a fresh window/document + evaluates app.js into it. `fetchImpl` is
// installed as window.fetch before app.js runs its init IIFE (which calls
// GET /api/config on load) — pass one even for tests that don't care about
// the config check, so that fire-and-forget call doesn't throw.
// Chart.js stand-in that records every chart the app builds, so UI tests can
// assert on datasets/destroy/update without a real canvas (jsdom has none).
function makeFakeChart() {
  const instances = [];
  class FakeChart {
    constructor(ctx, cfg) {
      this.ctx = ctx;
      this.config = cfg;
      this.data = cfg?.data || { datasets: [] };
      this.options = cfg?.options || {};
      this.updates = 0;
      this.destroyed = false;
      instances.push(this);
    }
    update() {
      this.updates++;
    }
    destroy() {
      this.destroyed = true;
    }
    resize() {}
    static getChart() {
      return null;
    }
  }
  FakeChart.instances = instances;
  return FakeChart;
}

// The page's export libraries at the versions index.html loads (devDependencies),
// for the export tests: exportLibs: true evaluates them in the window instead of
// the stubs.
const EXPORT_LIBS = [
  'xlsx/dist/xlsx.full.min.js',
  'jspdf/dist/jspdf.umd.min.js',
  'jspdf-autotable/dist/jspdf.plugin.autotable.min.js',
].map(f => [f, fs.readFileSync(path.join(ROOT, 'node_modules', f), 'utf8')]);

async function loadApp({ fetchImpl, url = 'http://localhost/', exportLibs = false } = {}) {
  const dom = new JSDOM(htmlWithoutScripts, { url });
  const context = dom.window;
  vm.createContext(context);

  context.fetch = fetchImpl || (async () => ({ ok: true, json: async () => ({}) }));
  // Unused by any Fund X-Ray code path; stubbed only so app.js's top-level
  // parse doesn't reference an undeclared global if it ever does at load time.
  // jsdom has no canvas backend; a truthy stub context lets chart-building run.
  context.HTMLCanvasElement.prototype.getContext = () => ({});
  context.Chart = makeFakeChart();
  context.XLSX = {};
  if (exportLibs) {
    // jsPDF's UMD attaches to the script's globalThis, which in this vm context
    // is not the page's window (a browser has one object for both); the
    // autoTable plugin then looks for window.jspdf, so copy it across first.
    for (const [filename, source] of EXPORT_LIBS) {
      vm.runInContext(source, context, { filename });
      context.jspdf = context.jspdf || vm.runInContext('globalThis.jspdf', context);
    }
  }

  vm.runInContext(splitsSource, context, { filename: 'public/splits.js' });
  vm.runInContext(peerSource, context, { filename: 'lib/analytics/peer.js' });
  vm.runInContext(fundGroupsSource, context, { filename: 'public/fund-groups.js' });
  vm.runInContext(appJsSource, context, { filename: 'public/app.js' });
  vm.runInContext(viewsSource, context, { filename: 'public/views.js' });

  // app.js's module-level state (TOP_FUND_GROUPS, xrayFilings, xraySnapshots,
  // currentXrayCompare, xrayCompareMode, ...) is declared with const/let, so
  // — exactly as in a real browser — it lives only in the script's lexical
  // scope, never as a `window.xrayFilings` property. This getter, defined in
  // that same shared scope, is the one hook tests use to read it: each
  // access re-evaluates the object literal, so it always reflects the
  // current values after calling into app.js's functions.
  vm.runInContext(
    `Object.defineProperty(window, '__state', {
      configurable: true,
      get() {
        return { TOP_FUND_GROUPS, xrayFilings, xraySnapshots, currentXrayCompare, xrayCompareMode, allResults, currentCompany };
      },
    });`,
    context,
    { filename: 'test-state-hook.js' }
  );

  // Let the init IIFE's pending microtask chain (fetchJSON('/api/config') ->
  // .json() -> renderWatchlist/populateTopFundsDropdown) settle before
  // returning control to the test, since it's an un-awaited async IIFE.
  await new Promise(resolve => context.setTimeout(resolve, 0));

  return { dom, window: context, document: context.document };
}

module.exports = { loadApp };
