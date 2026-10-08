// The workspace's HTML with a head written for each page (P9): link crawlers
// (LinkedIn, Slack, X) read <title>, the description and Open Graph tags
// without running JavaScript, so the server writes them into web/dist's
// index.html. Also robots.txt and sitemap.xml. Pure functions; server.js wires
// them to the warehouse (lib/api/warehouse.js pageMeta, sitemapEntries).
const fs = require('fs');

const SITE = 'Vantage';
const DEFAULT_TITLE = 'Vantage: private holdings and marks from SEC N-PORT';
const DEFAULT_DESCRIPTION =
  'Private-company holdings, per-share marks and position changes reported by SEC-registered funds in N-PORT ' +
  'filings since 2019, by company, share class, fund and firm. Every number links to its filing.';
// Static pages of the workspace, for their titles and the sitemap.
const STATIC_PAGES = {
  '/': { title: DEFAULT_TITLE },
  '/explore': { title: 'Explore: private holdings by firm, fund, company and class' },
  '/activity': { title: 'Activity: changes in newly filed N-PORT reports' },
  '/firms': { title: 'Firms by private value' },
  '/tracked': { title: 'Tracked private companies' },
  '/compare': { title: 'Compare private companies, firms and funds' },
  '/about': {
    title: 'About the data and methodology',
    description:
      'Where Vantage’s numbers come from: SEC N-PORT and N-CEN filings, the as-of rule, staggered fund calendars, ' +
      'reconciliation with EDGAR, golden numbers and known limits.',
  },
  '/status': { title: 'Data status', description: 'How current Vantage’s data is: newest filings, marks and refresh.' },
};

const escapeHtml = s =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

// A Cloudflare Web Analytics token: 32 hex characters, else ignored (it goes
// into a script attribute).
const analyticsToken = raw => (/^[a-f0-9]{32}$/i.test(String(raw || '')) ? String(raw) : null);

// The <head> additions for one page. origin: 'https://host' (no trailing slash).
function headTags({ title, description, origin, path, noindex = false, analytics = null }) {
  const t = title === DEFAULT_TITLE ? title : `${title} · ${SITE}`;
  const url = `${origin}${path}`;
  const image = `${origin}/og.png`;
  const tags = [
    `<title>${escapeHtml(t)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    `<meta property="og:site_name" content="${SITE}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:title" content="${escapeHtml(t)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    `<meta property="og:image:alt" content="${SITE}: private holdings and marks from SEC N-PORT filings" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${escapeHtml(t)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
  ];
  if (noindex) tags.push('<meta name="robots" content="noindex" />');
  if (analytics)
    tags.push(
      `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${analytics}"}'></script>`
    );
  return tags.join('\n    ');
}

// index.html with its own <title> and description replaced by headTags.
function renderIndex(html, head) {
  return html
    .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
    .replace(/<meta\s+name="description"[\s\S]*?\/>\s*/i, '')
    .replace(/<\/head>/i, `  ${head}\n  </head>`);
}

// The built index.html, read again only when the file changes (a deploy).
function indexReader(file) {
  let cached = null;
  return () => {
    const mtime = fs.statSync(file).mtimeMs;
    if (!cached || cached.mtime !== mtime) cached = { mtime, html: fs.readFileSync(file, 'utf8') };
    return cached.html;
  };
}

const slugOf = name =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// entries: { companies: [{ id, name, as_of }], firms: [{ id }] } or null.
function sitemapXml(origin, entries) {
  const urls = [
    ...Object.keys(STATIC_PAGES).map(p => ({ loc: `${origin}${p}` })),
    ...(entries?.companies ?? []).map(c => ({ loc: `${origin}/company/${c.id}-${slugOf(c.name)}`, lastmod: c.as_of })),
    ...(entries?.firms ?? []).map(f => ({ loc: `${origin}/firm/${f.id}` })),
  ];
  const body = urls
    .map(
      u => `<url><loc>${escapeHtml(u.loc)}</loc>${u.lastmod ? `<lastmod>${escapeHtml(u.lastmod)}</lastmod>` : ''}</url>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
}

const robotsTxt = origin => `User-agent: *\nDisallow: /legacy\nSitemap: ${origin}/sitemap.xml\n`;

module.exports = {
  DEFAULT_TITLE,
  DEFAULT_DESCRIPTION,
  STATIC_PAGES,
  escapeHtml,
  analyticsToken,
  headTags,
  renderIndex,
  indexReader,
  sitemapXml,
  robotsTxt,
  slugOf,
};
