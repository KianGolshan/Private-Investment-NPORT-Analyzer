# Lessons Learned (P0–P2, 2026-09-27/28)

These are the mistakes and surprises from building the warehouse, each with the rule that now prevents it.
Read this before starting a phase. Data traps with real examples live in [DATA-QUALITY.md](DATA-QUALITY.md);
this file is about **how we work**.

## Verifying numbers

1. **Every headline number was wrong at least once before it was right.**
   - Anthropic "as of 6/30" went $6.29B (bulk only) → $17.32B (plus catch-up, debt mixed in) → $15.51B
     (a scratch parser dropped `assetConditional` rows) → **$17.26B**.
   - Stripe holders went "50 → 35" (calendar buckets) → 48 → 34 (canonical filings) → an exit-blind
     as-of that counted closed funds → **49 / 35 / 34 / 37**.
   - Rule: never report a number until it has survived these checks:
     - amendments
     - blank series ID
     - exits
     - dead funds
     - debt vs. equity
     - `assetConditional`
     - a raw-EDGAR spot check of the largest contributor
2. **Challenge "real" findings too.** Three findings reversed under scrutiny:
   - The "May–Sep 2019 gap" was an NPORT-EX, not an N-PORT.
   - F14's "last report 2020-03-31" came from sorting `DD-MON-YYYY` dates as text.
   - Two "large file" timeouts turned out to be 150 KB files on stalled connections.

   Check the source (EDGAR index, submissions API, the file itself) before recording a cause.

3. **When the user's domain knowledge disagrees with the data, the data pipeline is the suspect.** The user
   knew Capital Group held "billions" of Anthropic. Chasing that found the bulk-cutoff and live-window
   blind spot (filings made 7/1–8/27 were visible to neither).
4. **Verify from the source, not from derived data.** Use a raw `primary_doc.xml`, the full submission
   `.txt`, EDGAR's `form.idx`, or the submissions API. GOLDEN-NUMBERS records the accession for each.

## Building

5. **Measure the keep rule before writing ingest.** "Keep equity at any fair-value level" would have
   stored about 1.9M public rows per quarter. The measured rule keeps all 1,613 tracked-company rows at
   about 70k rows per quarter: Level 3, restricted, or no check-digit-valid ISIN/CUSIP. Tickers are
   free text, never proof a holding is public.
6. **One parser, one keep rule.** Bulk rows and EDGAR-XML rows both go through `classifyInstrument` and
   `isPrivateCandidate`. Proven identical in all 21 fields on 106 real rows. Any new ingest path must pass
   the same parity test.
7. **Fixtures are real data, trimmed.** `test/fixtures/bulk/build-fixture.js` rebuilds them from the SEC
   dataset and EDGAR. Hand-written fixtures are only for shape-level unit tests.
8. **Tests found real bugs:**
   - An unopenable zip left `ingest_log` stuck on "running".
   - A migration test hard-coded the version list.

   Add a failure-path test for every job.

## Running jobs

9. **Long jobs run in the foreground, in timed batches, with visible progress.**
   - The first backfill attempt stored every Level-3 row, filled the disk, and stalled for 15 minutes.
   - A leftover `until …; sleep` wait loop then sat for 5.5 hours after its job was killed.
   - Now: batches under 10 minutes, resumable commands (`--missing`, catch-up skips loaded accessions),
     and no background waiters without an exit on failure.
10. **The SEC rate limit is the throughput ceiling:** about 9 filings/s through `fetchWithRetry`. Plan
    from the arithmetic: 11.8k filings ≈ 22 min, plus stragglers.
11. **The auto-mode safety classifier sometimes fails transiently.** After two consecutive no-verdicts, stop
    and report the exact resume point instead of burning retries. Resumable jobs make this painless.

## Working with the user

12. The user wants **real, verified data or nothing**, with negative findings reported. No speculative
    features. SpaceX is public.
13. **Phase gates are real.** Stop at each checkpoint for sign-off. Don't push, install schedulers, or
    change system config without an explicit yes.
14. The user is impatient with silent waits. Give a one-line status before any wait, and report what's
    actually running.

## Added in P3–P4

15. **Never edit an applied migration.** 0008 was changed after the live warehouse had run it, and
    the new table never appeared there. Add a new numbered migration; compare a fresh schema with the live
    one (`sqlite_master`) before committing.
16. **Edit scripts must read before they write.** `open(p,'w')` truncates first, and it emptied
    `refresh.js`. Restore from git, re-apply, run the suite.
17. **What the warehouse drops is evidence too.** The keep rule drops listed rows, so a listed company's
    stored rows look 100% private (Pfizer's PIPE). Check suggestions against the dropped data before a
    human reviews them.
18. **A second source needs its own completeness check.** The N-CEN data sets looked complete, but 2025 Q4
    lacked 16% of the filings EDGAR indexes. Compare every quarter with the index, as for N-PORT.
19. **Records can say less than they seem to.** Fundrise names Anthropic as >20% of net assets but not
    which vehicle holds it. Store what the filing says (a range) rather than a plausible mapping.
