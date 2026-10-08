# Lessons (how we work)

The rules we learned building v2; the stories behind each are in [archive/LESSONS-full.md](archive/LESSONS-full.md).
Data traps are in [DATA-QUALITY.md](DATA-QUALITY.md). Numbers are stable: code and docs cite them.

## Verifying numbers

1. A number is not reported until it survives amendments, blank series, exits, dead funds, debt vs. equity,
   `assetConditional`, and a raw-EDGAR check of its largest contributor.
2. Challenge "real" findings too: check the source (index, submissions API, the file) before recording a cause.
3. When the user's domain knowledge disagrees with the data, suspect the pipeline first.
4. Verify from the source (`primary_doc.xml`, `.txt`, `form.idx`), not derived data; record the accession.

## Building

5. Measure a keep rule (or any size-changing rule) on one quarter before writing ingest.
6. One parser, one keep rule; any new ingest path passes the bulk/XML parity test.
7. Fixtures are real data, trimmed and rebuilt by a builder; hand-written rows only for shape tests.
8. Every job gets a failure-path test.
9. Never edit an applied migration; add a new one and compare fresh vs. live schema.
10. Edit scripts read before they write.
11. What the warehouse drops is evidence too (listed rows look private).
12. A second source needs its own completeness check against EDGAR's index.
13. Store what a record says (a range), not a plausible mapping.
14. Seed suggestions get an adversarial pass; each error class becomes a rule and a test.
15. The filers' own identifiers beat name similarity.
16. Evidence rules stay honest: no ownership links from outside knowledge.
17. Measure misses by dollars (a ranked unresolved report), not by hunting name patterns.
18. Every evidence rule needs a pass over its own output; diff each re-seed against the last review.
19. Filer evidence can overturn a look-alike decision; show the user when it contradicts an instruction.
20. Check a derived test against a hand calculation.
21. Measure a threshold before agreeing it.
22. Order every query that feeds a first-wins or guarded step.
23. Test the edges of a row rule ($0 rows, units), not only the goldens.
24. A shared constant or helper lives in one module.
25. Each sentence of a plan that names a behavior gets one query or code read before sign-off.
26. Two answers to one question share one definition, and a test holds them equal (company_stats = exposureAsOf;
    market top, firm book and trend = exposureAsOf).
27. A cache key covers everything the answer depends on (refresh id + build). Look at the running app.
28. Never put untrusted text in a `String.replace` replacement string.
29. Test with the real library, not a stub (the Excel sheet-name bug).
30. Run each gate on its own before committing; a pipe's status is the last command's.
31. Measure the worst case and payload size, not only p95; bound answers by what the page shows.
32. Reconcile a measurement before building on it.
33. **Group by identity, display by name.** Keying a chart by a display name merged two funds into a fake 98.6%
    sell-down (trap 48). Keys are `fund_key`, company id, instrument key; names are labels.
34. **A rule that routes by today's status can hide history.** Sending every listed company to the live path hid
    years of private marks (trap 49). Check what a routing rule makes unreachable.
35. **Review your own work as an adversary before sign-off.** Two full reviews found real bugs the suite missed; each
    became a test on real rows.
36. **Diff a rule that merges identities against the previous build, warehouse-wide, before keeping it.** The
    trap-52 class merge moved $2.9B from mark to position on one 60:1 share exchange (Nscale) and turned a filer's
    relabel (Redwood) into a sale; the event-by-event diff against the old facts showed both in one query.
37. **A fix covers its neighbours, not only the reported case.** Three P6d fixes held for the reviewer's scenario and
    failed next to it: cleanup in `finally` after the commit (V03), a header-only adviser table (V04), the fund's
    newest filing (V06). Before calling a fix done, list and test every exit path (try/catch/finally), empty,
    header-only and zero inputs, the first, middle and latest item in time, and interleaved callers. Prefer a sweep
    that finds the cases itself (the post-commit fault-injection test) over a hand-picked list.
38. **Provenance must be consumed, not only recorded.** The curation digest hashed a snapshot the identity rebuild
    never read (it read `data/review/curation.json`, V02). A recorded input is proven by a test that changes it and
    sees the output change; one resolver hands it to every consumer, and a static guard keeps others away.
39. **Metadata travels with the data it labels.** An export's Source came from a separate "latest" fetch (V07);
    display and export disagreed on hidden values (V08). Labels come from the same response as the rows, and one
    function decides what a cell shows and what it exports.

## Running jobs

9. Long jobs run in the foreground, in timed batches under 10 minutes, resumable; no background waiters without an
   exit on failure (a leftover wait loop once ran 5.5 h).
10. The SEC rate limit (~9 filings/s) is the ceiling; plan from the arithmetic.
11. When something fails the same way twice, stop and report the resume point.
12. Record the machine's load with every latency number; compare only like with like.
13. Run the whole LIVE suite at a checkpoint, not only the goldens.
14. Never block the event loop of the server you are calling (a synchronous `curl` from inside the test server
    deadlocked).

15. This Mac has 8 GB of memory and 8 cores: one heavy job at a time, in the foreground (`npm test` already runs two
    files at a time); check `uptime` first and stop above a load of about 8; ask before a refresh, e2e or LIVE run.
    Two reviews running heavy suites at once nearly crashed it (2026-10-06).

## Working with the user

12. Real, verified data or nothing; report negative findings. SpaceX is public.
13. Phase gates are real: stop for sign-off; no push to main, schedulers or system config without an explicit yes.
14. Give a one-line status before any wait.
15. Compare across funds as filed at the same date; restate splits only within one series.
16. Weak identity links hide in bulk-accepted curation: "shares X" / "prefix of X" joined fund vintages (V vs VI)
    and an operating company into a fund. Before trusting a group, read the names behind it for numerals and
    different entities, then diff every row's company across the job (P8 pre-flight, trap 58).
17. Tests clean up what they make: a temp directory per test, never removed, filled 26 GB of disk in a week
    and threatened the nightly job. Make temp files through `test/helpers/tmp.js`; `npm run doctor` reports leftovers.
