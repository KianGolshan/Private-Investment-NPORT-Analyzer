# 0008: How the app reads the warehouse (parity scope, API shape, identifiers)

**Status:** accepted, 2026-09-30 (Phase 5 planning; user chose every recommendation). Implemented in P5a and P5b
(both signed off 2026-09-30). **Amended 2026-10-01 (post-P5 review):** decision 1 hid listed companies' stored
private-era marks; a listed company still answers from the live path, and its stored rows open on request
(`?stored=1`), labeled, with exits read as "not in stored rows" (DATA-QUALITY trap 49). Search marks the one result
that may open by itself (`strong`).

## Context

Checked against the code and the live warehouse on 2026-09-30 (archive/STATUS-history.md, "Phase 5 planning"):

- The warehouse holds private-candidate equity only (ADR 0003): no debt, and for listed companies only their
  restricted or PIPE rows. All 502 listed companies have some stored rows, so "the warehouse has seen this
  name" does not mean "the warehouse has the answer" (Pfizer: 1,079 filings price it at Level 1 in 2026q2,
  F24).
- v1 aggregates in the browser from per-filing calls on at most 250 EFTS hits, and dedupes on (date,
  shares, instrumentKey): amendments can be kept arbitrarily or counted twice, and exits are invisible.
- Company ids are assigned by SQLite at import and are not in the reviewed files, so a rebuilt warehouse
  renumbers them.
- Fund X-Ray needs every row of a filing (totals, listed and debt rows), not only the stored ones.
- The web and MCP servers must stay read-only (`openWarehouseReadOnly`); only jobs write.

## Decision

1. **Parity scope.** The source follows the company's status: private companies are answered from the
   warehouse; listed companies and debt from live EDGAR, labeled "live, not warehoused". A status change is
   a review item (P8 watch), never a silent switch. Parity means every v1 view keeps working; a number
   changes only where v1 was wrong, and GOLDEN-NUMBERS shows why.
2. **API shape.** Services in `lib/services/` (pure, over a db handle) back new routes (`/api/search`,
   `/api/companies/…`, `/api/funds/…`, `/api/freshness`). Every response carries `source` (`warehouse` |
   `live`), `refreshId` (also the ETag) and mark dates. v1's per-filing routes remain as a compatibility
   layer and for the live path.
3. **Identifiers.** Company ids are stable: written to the reviewed files, reproduced by any rebuild, never
   reused; a merged or dropped id redirects to its successor (`company_redirects`). URLs are
   `/company/<id>-<slug>`; the slug is cosmetic. Unreviewed entities are addressed by issuer key. MCP tools
   accept an id or a name and return ids.
4. **Lists.** One curated tracked list. Viewer watchlists stay in the browser, storing ids. Named lists, if
   wanted later, are an additive table.
5. **Unreviewed names** are searchable and answerable by a stored entity id, labeled "unreviewed" with their
   category, until curated.
6. **Curation from the app** ("make this a company", later rename/merge/track) is local and admin-only: the
   server stays read-only and runs the review import as a job under the refresh lock. The deployed path is
   decided before P9.
7. **Fund X-Ray's full-book fields** are stored per filing at ingest (`filing_totals`, both ingest paths),
   not fetched live. The capital-structure debt tranches are adopted into the warehouse only after measuring
   their size (a separate ADR 0003 amendment); until then that panel is live and labeled.
8. **Speed** is measured before it is optimized (`npm run bench`); precomputed tables are added only for
   routes that miss p95 < 200 ms, and are rebuilt by refresh.

## Consequences

- Warehouse answers are reproducible (canonical filings, exits, $0 positions); some v1 numbers change, each
  with its golden.
- The public site (P9) makes no SEC call for private companies or funds; the live paths are off or behind a
  low limit there.
- New schema: `company_redirects`, `entities` + `holdings.entity_id`, an FTS5 search index, `filing_totals`,
  and any precomputed tables, all within the 600 MB budget (prune first).
- The reviewed files gain company ids, so diffs of `data/review/` show id changes explicitly.
