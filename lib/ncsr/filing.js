// What an N-CSR filing is, apart from its tables: the series its header names, the
// fund report each series is, and the document that holds the shareholder report.
// Shared by the pilot (scripts/ncsr-pilot.js) and the ingest (lib/warehouse/ncsr.js).

// The series a filing covers, from its SGML header (the filer's own identifiers).
function headerSeries(text) {
  const t = String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  const out = [];
  for (const m of t.matchAll(/<SERIES-ID>\s*(S\d{9})\s*<SERIES-NAME>\s*([^\n<]+)/g))
    out.push({ seriesId: m[1], name: m[2].trim() });
  return out;
}

const normName = s =>
  String(s)
    .toLowerCase()
    .replace(/[®™]/g, '')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// The one series a parsed fund report belongs to: by its printed name among the
// header's series; a report without a name (one fund per filing) only when the header
// names exactly one series. Never a near-name guess.
function seriesFor(fund, series) {
  if (fund.fundName === null) return series.length === 1 ? series[0] : null;
  const hits = series.filter(s => normName(s.name) === normName(fund.fundName));
  return hits.length === 1 ? hits[0] : null;
}

// The document holding the shareholder report. Usually the primary document; before 2022
// T. Rowe Price filed a short cover (119 KB) with the report as an exhibit, so a small
// primary document gives way to the filing's largest HTML file. fetchText(name) returns a
// document of the filing as text; fetchIndex() its index.json.
const SMALL_PRIMARY = 1024 * 1024;
async function reportDocument(primaryDocument, fetchText, fetchIndex) {
  const html = await fetchText(primaryDocument);
  if (html.length >= SMALL_PRIMARY) return { name: primaryDocument, html };
  const index = await fetchIndex();
  const docs = index.directory.item
    .filter(x => /\.html?$/i.test(x.name) && !/index/i.test(x.name) && Number(x.size) > html.length)
    .sort((a, b) => Number(b.size) - Number(a.size));
  if (!docs.length) return { name: primaryDocument, html, images: index.directory.item.filter(isImage).length };
  return { name: docs[0].name, html: await fetchText(docs[0].name) };
}
const isImage = x => /\.(jpe?g|gif|png)$/i.test(x.name);

// A report printed as page images (T. Rowe Price 2020 to mid-2022: 43 JPG pages and a
// 119 KB text document whose notes mention the portfolio but hold none of it): nothing a
// parser can read, so the filing is recorded as unreadable rather than retried. The test is
// the portfolio's own markers: a cost ("Acquisition") or a net-assets line ("NET ASSETS",
// "Net assets 100.00%", "Net Assets (100.0%)"), never words a note can cite.
function imageOnly(html, images) {
  return images >= 10 && !/Acquisition|NET ASSETS|Net assets 100|Net Assets \(100/.test(html);
}

module.exports = { headerSeries, normName, seriesFor, reportDocument, imageOnly, SMALL_PRIMARY };
