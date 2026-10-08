// P9 W2: the head the server writes into each workspace page for link
// crawlers, robots.txt and sitemap.xml (lib/api/pages.js), and the titles,
// descriptions and not-found answers read from the warehouse (pageMetaOf).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const pages = require('../lib/api/pages');
const { pageMetaOf, warehouseRouter } = require('../lib/api/warehouse');
const { goldenWarehouse } = require('./helpers/warehouseApp');

const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Vantage — old title</title>
    <meta
      name="description"
      content="old description"
    />
    <link rel="icon" href="x" />
  </head>
  <body><div id="app"></div></body>
</html>`;

test('head tags: title, description, canonical, Open Graph and Twitter; every value escaped', () => {
  const head = pages.headTags({
    title: 'A & B "Co" <script>',
    description: "It's <b>bold</b>",
    origin: 'https://vantage.example.com',
    path: '/company/1-a-b',
  });
  assert.match(head, /<title>A &amp; B &quot;Co&quot; &lt;script&gt; · Vantage<\/title>/);
  assert.match(head, /<meta name="description" content="It&#39;s &lt;b&gt;bold&lt;\/b&gt;" \/>/);
  assert.match(head, /<link rel="canonical" href="https:\/\/vantage.example.com\/company\/1-a-b" \/>/);
  assert.match(head, /<meta property="og:image" content="https:\/\/vantage.example.com\/og.png" \/>/);
  assert.match(head, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.doesNotMatch(head, /<script|noindex/);
  // the default title is not suffixed; noindex and analytics when asked
  const def = pages.headTags({
    title: pages.DEFAULT_TITLE,
    description: pages.DEFAULT_DESCRIPTION,
    origin: 'http://localhost:3000',
    path: '/',
    noindex: true,
    analytics: '0123456789abcdef0123456789abcdef',
  });
  assert.match(def, new RegExp(`<title>${pages.DEFAULT_TITLE}</title>`));
  assert.match(def, /<meta name="robots" content="noindex" \/>/);
  assert.match(
    def,
    /static\.cloudflareinsights\.com\/beacon\.min\.js" data-cf-beacon='\{"token": "0123456789abcdef0123456789abcdef"\}'/
  );
});

test('analytics token: only 32 hex characters are accepted', () => {
  assert.equal(pages.analyticsToken('0123456789ABCDEF0123456789abcdef'), '0123456789ABCDEF0123456789abcdef');
  for (const bad of ['', null, undefined, 'abc', `${'a'.repeat(32)}"><script>`, 'g'.repeat(32)])
    assert.equal(pages.analyticsToken(bad), null, String(bad));
});

test("renderIndex replaces the built page's title and description, keeps the rest", () => {
  const head = pages.headTags({ title: 'T', description: 'D', origin: 'https://x.test', path: '/about' });
  const html = pages.renderIndex(INDEX, head);
  assert.equal((html.match(/<title>/g) || []).length, 1);
  assert.equal((html.match(/name="description"/g) || []).length, 1);
  assert.match(html, /<title>T · Vantage<\/title>/);
  assert.match(html, /<link rel="icon" href="x" \/>/);
  assert.match(html, /<div id="app"><\/div>/);
  assert.ok(html.indexOf('og:title') < html.indexOf('</head>'));
});

test('robots.txt and sitemap.xml: static pages, companies with slugs and dates, firms; escaped; no warehouse', () => {
  assert.equal(
    pages.robotsTxt('https://x.test'),
    'User-agent: *\nDisallow: /legacy\nSitemap: https://x.test/sitemap.xml\n'
  );
  const xml = pages.sitemapXml('https://x.test', {
    companies: [
      { id: 1, name: 'Anthropic PBC', as_of: '2026-08-31' },
      { id: 7, name: 'A&B Co.', as_of: null },
    ],
    firms: [{ id: 3 }],
  });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?><urlset /);
  assert.match(xml, /<url><loc>https:\/\/x.test\/<\/loc><\/url>/);
  assert.match(xml, /<loc>https:\/\/x.test\/about<\/loc>/);
  assert.match(xml, /<url><loc>https:\/\/x.test\/company\/1-anthropic-pbc<\/loc><lastmod>2026-08-31<\/lastmod><\/url>/);
  assert.match(xml, /<url><loc>https:\/\/x.test\/company\/7-a-b-co<\/loc><\/url>/);
  assert.match(xml, /<loc>https:\/\/x.test\/firm\/3<\/loc>/);
  const bare = pages.sitemapXml('https://x.test', null);
  assert.equal((bare.match(/<url>/g) || []).length, Object.keys(pages.STATIC_PAGES).length);
});

test('page meta from the warehouse: company (with its stored stats), redirect, fund, firm; unknown ones are not found', () => {
  const { db, idOf, firmIdOf } = goldenWarehouse();
  const id = idOf('Anthropic');
  const s = db.prepare('SELECT * FROM company_stats WHERE company_id = ?').get(id);
  const c = pageMetaOf(db, `/company/${id}-anthropic`);
  assert.equal(c.title, 'Anthropic: fund holdings and marks');
  assert.match(c.description, new RegExp(`^Anthropic in SEC N-PORT filings\\. ${s.current_funds} funds reported \\$`));
  assert.match(c.description, /as of [A-Z][a-z]{2} \d{1,2}, \d{4}\. Holdings, per-share marks/);
  assert.deepEqual(pageMetaOf(db, `/company/${id}`), c, 'the slug is optional');
  // a retired id reads as the company it moved to; a dropped one is not found
  db.prepare(
    "INSERT INTO company_redirects (old_id, old_name, new_id, reason, retired_at) VALUES (99001, 'Anthropic (old)', ?, 'merged', 'x')"
  ).run(id);
  db.prepare(
    "INSERT INTO company_redirects (old_id, old_name, new_id, reason, retired_at) VALUES (99002, 'Gone Co', NULL, 'dropped', 'x')"
  ).run();
  assert.equal(pageMetaOf(db, '/company/99001-anthropic-old').title, c.title);
  for (const p of [
    '/company/99002',
    '/company/424242',
    '/company/abc',
    '/company/0',
    '/fund/NOPE',
    '/firm/0',
    '/firm/x',
  ])
    assert.deepEqual(pageMetaOf(db, p), { notFound: true }, p);
  assert.deepEqual(pageMetaOf(db, '/company/%E0%A4%A'), { notFound: true }, 'bad percent-encoding');
  // other paths: the default head
  for (const p of ['/', '/explore', '/name/ANTHROPIC', '/company/1/extra']) assert.equal(pageMetaOf(db, p), null, p);
  // a fund by its key
  const f = db
    .prepare("SELECT fund_key, series_name FROM fund_names WHERE series_name LIKE 'Growth Fund of America%'")
    .get();
  const fm = pageMetaOf(db, `/fund/${encodeURIComponent(f.fund_key)}`);
  assert.equal(fm.title, `${f.series_name}: private holdings`);
  assert.match(fm.description, /private-company holdings, marks and changes from its SEC N-PORT filings, .+ to .+\.$/);
  // a firm, and a company with no current holders says no numbers
  const firmId = firmIdOf('Capital Group (American Funds)');
  assert.equal(pageMetaOf(db, `/firm/${firmId}`).title, 'Capital Group (American Funds): private-company book');
  db.prepare('UPDATE company_stats SET current_funds = 0, current_value_usd = 0 WHERE company_id = ?').run(id);
  assert.equal(
    pageMetaOf(db, `/company/${id}`).description,
    'Anthropic in SEC N-PORT filings. Holdings, per-share marks and changes by fund, firm and share class, each linked to its filing.'
  );
});

test('/api/stats: counts from the tables; the router gives sitemap entries and page meta, or null without a warehouse', async () => {
  const { db } = goldenWarehouse();
  const router = warehouseRouter(() => db);
  const app = express().use('/api', router);
  const r = (await request(app).get('/api/stats').expect(200)).body.stats;
  assert.equal(r.filings, db.prepare('SELECT COUNT(*) n FROM filings').get().n);
  assert.equal(r.privateCompanies, db.prepare("SELECT COUNT(*) n FROM companies WHERE status = 'private'").get().n);
  assert.equal(r.funds, db.prepare('SELECT COUNT(DISTINCT fund_key) n FROM filings').get().n);
  assert.ok(r.firstFilingDate <= r.newestFilingDate);
  const e = router.sitemapEntries();
  assert.ok(e.companies.length > 0 && e.firms.length > 0);
  assert.ok(e.companies.every(c => Number.isInteger(c.id) && c.name));
  assert.ok(router.pageMeta('/company/1') !== undefined);
  const none = warehouseRouter(() => {
    throw new Error('no file');
  });
  assert.equal(none.sitemapEntries(), null);
  assert.equal(none.pageMeta('/company/1'), null);
});
