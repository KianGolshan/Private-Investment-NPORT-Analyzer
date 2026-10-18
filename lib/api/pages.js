// The workspace's HTML with a head written for each page (P9): link crawlers
// (LinkedIn, Slack, X) read <title>, the description and Open Graph tags
// without running JavaScript, so the server writes them into web/dist's
// index.html. Also robots.txt and sitemap.xml. Pure functions; server.js wires
// them to the warehouse (lib/api/warehouse.js pageMeta, sitemapEntries).
const fs = require('fs');

const SITE = 'Vantage';
const DEFAULT_TITLE = 'Vantage: private-company holdings and marks from SEC fund filings';
// The positioning line and its description (review 2026-10-15 W4); at most 160 characters.
const DEFAULT_DESCRIPTION =
  'Which SEC-registered funds hold private companies like Anthropic and Stripe, what each marks a share at, ' +
  'and how that changes. From N-PORT filings since 2019.';
// Static pages of the workspace, for their titles and the sitemap.
const STATIC_PAGES = {
  '/': { title: DEFAULT_TITLE },
  '/explore': { title: 'Explore: private holdings by firm, fund, company and class' },
  '/activity': { title: "What's new: changes in newly filed N-PORT reports" },
  '/firms': { title: 'Firms by private value' },
  '/watchlist': { title: 'Watchlist and tracked companies' },
  '/compare': { title: 'Compare private companies, firms and funds' },
  '/about': {
    title: 'About',
    description:
      'What Vantage shows and how: SEC N-PORT and N-CEN filings, the as-of rule, staggered fund calendars, the words ' +
      'it uses, its limits and its author.',
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
    `<meta property="og:image:alt" content="${SITE}: private-company holdings and marks reported by SEC-registered funds" />`,
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

// index.html with its own <title> and description replaced by headTags. The
// head carries filer text (fund and company names), so it goes in through a
// function, never a replacement string, where "$`" or "$'" would copy parts of
// the page (LESSONS 28, review L2).
function renderIndex(html, head) {
  return html
    .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
    .replace(/<meta\s+name="description"[\s\S]*?\/>\s*/i, '')
    .replace(/<\/head>/i, () => `  ${head}\n  </head>`);
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

const robotsTxt = origin => `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;

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
