// Second discovery lever for scripts/build-fund-index.js, alongside
// fund-candidates.js. Instead of guessing fund/registrant names, this list
// is well-known private (or recently-private) companies that mutual funds
// have publicly been reported to mark — SpaceX, OpenAI, Stripe, etc. For
// each name, the build script runs the SAME EDGAR full-text search
// /api/search-nport already uses for Single Security search (restricted to
// NPORT-P forms) and pulls the CIK of every fund whose own filing actually
// reports a holding by that name — a fund only gets added this way because
// its own real filing says so, not because of anything on this list.
//
// This tends to surface funds fund-candidates.js's guessed names miss
// entirely (many marketing fund names don't match their EDGAR registrant's
// legal name, which is what company-name lookup requires) or misses
// because it's a small/newer growth fund rather than a huge legacy one.
// Add more names here and rerun `npm run build-fund-index`.
module.exports = [
  'OpenAI',
  'Anthropic',
  'SpaceX',
  'Stripe',
  'Databricks',
  'Ramp',
  'Discord',
  'Canva',
  'Plaid',
  'Chime',
  'Klarna',
  'Revolut',
  'Scale AI',
  'xAI',
  'Rippling',
  'Deel',
  'Fanatics',
  'ByteDance',
  'Epic Games',
  'Anduril',
  'Perplexity',
  'Groq',
  'Cerebras',
  'Neuralink',
  'Notion',
  'Navan',
  'Brex',
  'Vercel',
  'Miro',
  'Turing',
  'Wiz',
];
