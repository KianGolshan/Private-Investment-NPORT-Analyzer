# Project check: debugging, security and data integrity (2026-10-22)

Asked: "a comprehensive debug and security and data integrity check across the entire project". Run on this Mac
against the full local warehouse (generation 42) and the golden fixture, plus read-only requests to the live site
(build `092af18`, generation 44). The UI side was covered the day before ([UI-COVERAGE.md](../UI-COVERAGE.md)).

## Result

Four defects found, all fixed with a test that fails on the old code; no security vulnerability and no data error.

| #   | Area  | Found                                                                                                                                                                                    | Fix                                                                                         |
| --- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| C1  | API   | `period=__proto__` or `period=constructor` passed validation (a plain-object lookup) and crashed `/api/analysis/pivot` and `/api/sectors/index` with a 500; `kind=__proto__` passed too. | Own keys only (`Object.hasOwn`). Test: `analysis.test.js` bad filters.                      |
| C2  | API   | An `/api` path no route answers (an unknown route, an empty id such as `/api/companies/`) got Express's HTML page instead of a JSON error.                                               | `apiNotFound` (lib/api/warehouse.js), mounted last in server.js.                            |
| C3  | Jobs  | A job whose reviewed folder could not be read (missing, unreadable) left its staged copy in the temp folder: the stage was made before the read and never handed back to the cleanup.    | `stageCuration` removes its own stage on failure. Test: `job.test.js`.                      |
| C4  | Tests | The crash drill's killed job left its stage in the system temp folder; 1,974 stale `vantage-*` folders had built up (empty, from tests).                                                 | The drill's child job stages in the test's own temp folder; the stale folders were removed. |

A full `npm test` now leaves no temp folder behind (checked by count before and after).

## What was checked

**Gates:** backend 496 (492 pass, 4 skipped, 0 fail; with the new `api-fuzz.test.js`); web unit 71; browser
suite (app, consistency) 22/22 on the golden warehouse; lint and format clean. `npm run doctor`: healthy; its
warnings are this Mac's copy (15 days since the last local refresh; the live site refreshed the morning of
2026-10-21) and the temp folders of C4.

**Security**

- Dependencies: `npm audit` 0 vulnerabilities (root, production only, and web). The SheetJS tarball is 0.20.3, past
  the published advisories.
- Secrets: none in tracked files or anywhere in git history (Anthropic, AWS, GitHub keys, private keys, DuckDNS and
  healthchecks tokens); `.env` is ignored and never committed.
- SQL: every visitor value is a bound parameter; the only text built into SQL comes from fixed lists (table names,
  column lists, placeholders) or a validated lookup (`EQUITY_BY`). No visitor value reaches a regular expression.
- Headers (local and live): strict CSP (`script-src 'self'`), `frame-ancestors 'none'`, nosniff, no referrer,
  permissions policy; HSTS from Caddy on the live site; HTTP redirects to HTTPS.
- Admin: needs `VANTAGE_ADMIN=1`, a loopback socket with no proxy headers (Caddy always adds them), a local Host
  and an `X-Vantage-Admin` header; live answers 403.
- Redirects: merged-id and `/tracked` redirects stay on the site; `//host` paths do not redirect off it.
- Deployment: services run as `vantage`/`vantage-web` with `ProtectSystem=strict`, `NoNewPrivileges`, private temp
  and memory caps; only the auto-deploy unit keeps privileges (it restarts the instances through a sudoers rule
  limited to three restarts).
- API fuzz: 14,172 requests (every route, path ids and every query parameter it reads, each with hostile values:
  injection strings, huge and negative numbers, impossible dates, `__proto__`, repeated and object-shaped
  parameters, 20,000-character values). After C1 and C2: no 5xx, every error JSON, none slow. Error messages echo
  the bad value inside JSON (served as JSON with nosniff, shown by the page as text): not exploitable.

**Data integrity (full warehouse, 1,165,448 holding rows, 355,007 filings)**

- `0` holdings without their filing, duplicate holding rows, filings without a fund key, canonical filings outside
  `filings`, funds with two canonical filings for one report date, report dates after filing dates, future filing
  dates, non-numeric values, rows tagged to a missing company or to both a company and an unreviewed name, position
  facts without their filing or prior filing, position facts whose effects do not add to their change, private
  operating companies without an industry decision, decisions naming an unknown industry, empty or duplicate
  company names.
- Rows filed below $0: 2,813 are short positions in public companies (out of scope); 25 are private and count as $0
  as filed (trap 57, updated with the operating-company cases; Aergo Capital's $35,618,694.47 at 2026-06-30 equals
  its rows with the −$16,756.30 one at $0).
- Stored company totals equal a fresh `exposureAsOf` for 60 random companies at their dates (value and funds).
- Id ledgers: no duplicate ids; every company and firm id in the warehouse is in `company_ids.csv` /
  `manager_ids.csv`; the four ledger ids not in the warehouse are merged companies with redirects.
- Against EDGAR: the LIVE regression 4/4 (filing lists equal EDGAR submissions; goldens A1–A6; the reviewed
  entities; filing totals); the raw-EDGAR oracle 6/6; 12 random private positions filed since mid-2025 equal raw
  `primary_doc.xml` to the share and the cent (e.g. xAI Series C in Fidelity Contrafund, 264,240 shares,
  $9,660,614.40, 0000035402-25-002229).

## Not changed (with the reason)

- Error messages repeat the value that was refused: useful to the caller, harmless as JSON.
- The local warehouse is 15 days behind the live one: a refresh on this Mac is the user's call.
