# P8 pre-flight analysis (2026-10-07)

A whole-project check before P8 (operations) starts, on branch `v2-p8-operations` (= `main` at ed3fd6e, PR #7
merged). It covers the gates, the job and refresh path, the API, the SEC client, live-warehouse data probes and
alignment with the v2 goal.

## Gates (all green)

- `npm test`: 613 tests, 582 pass, 0 fail, 31 skipped (LIVE), 111 s at load ~3.
- `npm run lint`, `npm run format:check`, `npm run test:web`, `npm run lint:web`: clean.
- `npm audit` (root, web): 0 vulnerabilities. CI on `main` after the PR #7 merge: success.
- Warehouse generation 29: `ingest_errors` 0; 0 filings with a future report date, 0 filed before their report
  date, 0 without a fund key. Newest filing 2026-10-05, newest report date 2026-08-31.

## Findings, most severe first

### High: these break an unattended nightly run (the P8 success criterion)

1. **The test suite leaks about 1.6 GB of temp files per `npm test` run.**
   - `test/job.test.js` `tmpWarehouse()` writes the 54 MB golden warehouse to a new `vantage-job-*` directory per
     test and never removes it. `make-company`, `ncen-refresh` and `prod-startup` tests also create temp dirs
     without removing them.
   - `$TMPDIR` holds about 2,000 such directories, 26 GB in total (25 GB of it `vantage-job-*`). Today's two runs
     alone added 182 directories (3.2 GB).
   - The disk is at 94%, with 12 GiB free. A refresh needs about 1.3 GB of headroom (a 578 MB candidate plus the
     bulk zip), so a few more days of test runs would make the nightly job fail on disk space.
2. **A stalled download hangs a job forever, while it holds the lock.**
   - `lib/warehouse/bulk-source.js:34-55` streams the zip with axios `timeout: 120000`. That timeout covers only the
     wait for the response, not the body. A body that stops arriving without closing never settles the promise.
   - `runJob` has no wall-clock limit, and the heartbeat keeps the lock fresh. A live process on the same host is
     never taken over, so every later night gets a 409 and nothing publishes.
   - This breaks the CLAUDE.md rule that background jobs must have a terminal state.
3. **The lock checks only the pid to decide whether its holder is alive** (`lib/warehouse/job.js:146-148`).
   - After a crash or power loss and a reboot, the pid in a leftover lock can belong to an unrelated process.
     `alive(pid)` is then true, and the lock blocks every job until someone removes it by hand.
   - The lock should also record the process start time (or the boot time) and compare it.
4. **A job killed mid-run leaves "Job running" on screen forever.**
   - `warehouse.db.job.json` keeps `status: running` after a SIGKILL or power loss.
   - `jobOf()` in `lib/api/warehouse.js:95` reports it with no liveness check, so the top-bar pill says "Job running"
     indefinitely.
   - `npm run doctor` and the freshness route should treat a running state with a dead pid as "interrupted".

### Medium: correctness and wording

5. **Negative fair values read as "$0".**
   - 18 private-company rows are filed below zero, as low as −$266,756: JLL Partners Fund VII Secondary, Carlyle
     AlpInvest Private Markets Fund, `0001049169-26-001560`. Others are Apax XI and Clearlake VI in Flowstone, and
     Triton IV in Pomona. All are PE fund interests, where a negative value is plausibly unfunded or recallable
     carry.
   - `asof.countsRule` and `position-facts.js` keep them as rows that are reported but do not count, so they are
     labeled "reported at $0".
   - The value as filed is negative. That conflicts with "words as the filings allow", and DATA-QUALITY has no trap
     for it.
   - Verify on raw EDGAR (`verify-edgar.js`) before deciding the label, for example "reported below $0".
6. **The counting rule is written twice.** `lib/warehouse/position-facts.js:29` re-implements
   `asof.countsRule(true)` instead of importing it. The two agree today, but this breaks "reuse, don't
   re-implement", and nothing tests that they stay equal.
7. **A curation label is misleading.** Company 743 "Alpinvest Secondary Fund Viii" holds rows titled
   **"ASF VIII Sidecar (Cayman), LP"**: a separate vehicle that every Thrivent allocation fund holds next to
   company 205, AlpInvest Secondaries Fund (Offshore Feeder) VIII. It reads like a duplicate of 205. Rename it to
   the sidecar, or link the two as one brand; it should not be merged into 205.
8. **STATUS was stale.** It still described PR #7 as open on `v2-p6e-verification` and "P7 or P8" as undecided.
   The suite count was 598 (now 613), and the "Next session" text cited PR #5. Fixed in this pass.

### Known and already carried (alignment gaps, not new)

- **"Refreshed automatically" is not met yet.** The launchd job is not installed, and the data is two days old
  (newest filing 2026-10-05). This is P8's core.
- **No backup beyond two generations on the same disk.** The data can be rebuilt from SEC plus the curation in git
  (about 41 min of ingest), so the risk is time, not loss.
- **A share exchange reads as a mark move** (`public/splits.js` knows a fixed list of ratios). Mesquite Energy
  (F52) is Market's largest move down, at −$801.4M. That is a headline number on the home view, and it is an
  artifact of the share count changing.
- `companies.public_since` is empty for all 504 listed companies. That is P8 research.
- The server memo is bounded by entry count, not by bytes (R17, P9).
- v1's retired tab code (`public/app.js`, 4.6k lines) is still in the repo.

## Alignment with the v2 goal

- **Met:**
  - every view the goal names (security → issuer → fund → manager, at any date) answers from the warehouse;
  - per-share marks and the change words (first reported, added, reduced, no longer reported, mark moved);
  - data from 2019Q4;
  - every number carries its accession and mark date.
- **Not yet met:**
  - automatic refresh (P8);
  - per-share marks across share exchanges (finding: splits);
  - the data-quality labeling of below-zero marks (finding 5).

## Recommended P8 W1 order

1. Fix the test temp leak (`t.after` cleanup, guarded by a test that counts `$TMPDIR` entries), then clear the
   26 GB of leftovers (the user's call).
2. Job watchdog: an idle timeout on streamed downloads and a wall-clock cap on `runJob` that fails the job and
   releases the lock.
3. Lock identity: record the process start time and judge a lock stale when it differs; report an interrupted
   `running` state as interrupted.
4. `npm run doctor`, covering:
   - freshness;
   - the lock and job state;
   - free disk space against the job's needs (also checked by `runJob` before copying);
   - leftover temp directories;
   - row counts;
   - unresolved value.
5. Then the planned P8 items: backup with a restore drill, the launchd job (with the user's yes), alerting, the
   monthly LIVE regression, the watch reports.

## Outcome (2026-10-07, same day): every finding fixed

The user said "proceed with full fixes". Each fix has a regression test; the ones that guard old behavior fail
on the pre-fix code (the stall test times out; the counting-rule invariant fails; the job tests call functions
the old code lacks).

| #   | Finding                 | Fix                                                                                                                                                                                                                                                                |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Test temp leak          | `test/helpers/tmp.js` (removed per test and at exit); every test uses it (invariant). A full `npm test` now leaves 0 directories (was ~280, ~1.6 GB). `runJob` refuses to start without room for a candidate plus 1 GiB (507).                                     |
| 2   | Stalled download        | `downloadQuarter` fails after 60 s without data and removes the partial zip; `runJob` has a time limit (3 h, `VANTAGE_JOB_TIMEOUT_MIN`), checked while it awaits and between synchronous steps; job CLIs exit after a failure.                                     |
| 3   | Pid-only lock           | The lock and the state record the process start time (`ps -o lstart`) and the boot time; a live pid with another start time, or a rebooted host, is gone (`job-state.holderGone`). A job removes candidates left by interrupted jobs (found by the SIGKILL drill). |
| 4   | Stale "running" state   | `jobState` reports `interrupted`; the top bar shows "Last job interrupted"; `npm run doctor` fails on it. Verified in the browser with a dead job's state written to the live state file (then restored).                                                          |
| 5   | Negative values as "$0" | Verified on raw EDGAR (Apax XI −$186,267; JLL Partners Fund IX −$266,756; Triton Fund 6 SCSp −$82,065.81). Counted as $0 as before; the holders list and the Filings tab say "reported below $0 (counted as $0)" (trap 57).                                        |
| 6   | Counting rule twice     | `position-facts.js` uses `asof.countsRule`; an invariant keeps it single.                                                                                                                                                                                          |
| 7   | Company 743 label       | Renamed in place to "ASF VIII Sidecar (Cayman)" (id kept).                                                                                                                                                                                                         |
| 8   | STATUS stale            | Rewritten for P8.                                                                                                                                                                                                                                                  |
| —   | `npm run doctor`        | `lib/warehouse/doctor.js`, read-only; exits 1 on a failed or interrupted job or no disk room.                                                                                                                                                                      |

### Found while fixing 5: 20 companies that merged several funds (trap 58)

Checking the negative rows on EDGAR showed two of them under the wrong fund ("JLL Partners Fund IX" under JLL
Partners Fund VII Secondary; "Triton Fund 6 SCSp" under Triton Fund IV). The cause: `issuerKeyOf` drops a
trailing one-letter or two-digit token as a class, and the seed's "shares" / "extends" / "prefix of" links,
accepted in review, joined sibling funds. A scan of every private company's row names for fund numerals found
20 such companies:

- Insight Venture Partners X;
- Francisco Partners V;
- New Enterprise Associates 17;
- Genstar Capital Partners IX;
- GTCR Fund XIII/B;
- Triton Fund IV;
- Icon Partners IV;
- Kohlberg TE Investors VIII-B;
- JLL Partners Fund VII Secondary;
- HgCapital 7 C;
- Formentera Partners Fund II;
- KKR European Fund V SCSp;
- Permira VII L.P. 1;
- TPG Asia VII;
- DF Residential III;
- Altor Fund V AB;
- Clearlake Capital Partners VI;
- Octagon Investment Partners 42 (17 CLOs);
- Audax Senior (Loan Fund I and III);
- Vistria Fund IV.

Four more links named other entities:

- "INSIGHT" (Insight M, Inc.) under Insight Venture Partners X;
- "LOGAN" (Logan Group Co Ltd, a property developer) under Logan Re 2027;
- "QUIET" (Quiet T1, Quiet SPV R9) under Quiet OA Access;
- "BLACKSTONE PARTNERS" (Blackstone Partners V LP) and "LEGACY" (a notes claim) under their companies.

**The split** (`data/review/aliases.csv`, generations 30–31; companies 806 → 900, private 302 → 396, tracked
180 unchanged):

- an alias that names one fund moves to that fund's company;
- a stripped key becomes an anchored regex per fund (regex aliases outrank issuer keys);
- names with no fund and no evidence are left unreviewed: Triton Fund, Ltd. (a hedge fund in Evanston),
  "Francisco Partners, L.P.", a plain "Insight Venture Partners", "DF Residential LP" and Logan Group;
- the plain "Clearlake Capital Partners" stays with V on evidence (one instrument id across both titles);
- the NEA regexes exclude "Venture Growth" funds.

**Diff, every holding row, generation 29 → 31:**

- 2,955 rows changed company, all within these 24 companies;
- 98 rows ($187.1M summed over all dates) left unreviewed;
- 15 previously unreviewed rows were claimed:
  - 12 Octagon 36 debt tranches (not in equity views);
  - 3 Partners Group rows titled "New Enterprise Associates 18, L.P." whose issuer field says "NEA 18 Venture
    Growth Equity". The resolver reads the title, so they count as NEA 18; this is a judgment call.

**Left as they are, for the user to overrule:** groupings of one manager's vehicles that are not different
vintages:

- Five Arrows co-invest vehicles;
- HOF Capital SPVs;
- Parthenon Kairos;
- Greenbriar co-invests;
- EQT VIII co-investment;
- Disruptive Technology Solutions series;
- FTAI SPVs;
- Beacon Re Committed / Uncommitted.

Operating companies' "shares" links (classes, holdcos) were read and are sound.

**Not done:** deleting the ~26 GB of leftover test directories. The permission classifier blocked the sweep;
it is the user's command to run (STATUS).
