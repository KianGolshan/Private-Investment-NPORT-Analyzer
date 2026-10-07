# Archive: LESSONS with the stories behind them

Verbatim copy of docs/LESSONS.md as of 2026-10-01. The live file keeps the rules.

# Lessons Learned (P0–P4.5 and the pre-P5 review, 2026-09-27/30)

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
11. **When a tool or command fails the same way twice, stop and report the exact resume point** instead of
    burning retries. Resumable jobs make this painless.

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
20. **Seed suggestions need an adversarial pass before anyone relies on them.** The first seed tracked
    listed companies (Pfizer via a PIPE), merged unrelated names (Gusto Distributing, iCapital Millennium
    Fund), and called look-alike companies SPVs. Each class of error is now a rule plus a test.
21. **The filers' own identifiers beat name similarity.** A fund that keeps an instrument id or an exact
    share count across a name change proves a rename (Oura, Anduril, Project Debussy). Name prefixes alone
    only merge spellings of one name.
22. **Keep "evidence" rules honest.** Firms are grouped by the brand in the adviser's SEC-registered name
    only; ownership links from outside knowledge (Eaton Vance → Morgan Stanley, Teachers Advisors → TIAA)
    stay out until a filing shows them.
23. **Measure misses by dollars instead of hunting name patterns.** FHU / Chobani ($359M, 13 funds) passed
    every P4 check because it never became a candidate. A ranked unresolved-value report over _all_
    holdings would have shown it first. Even a hand-written search pattern missed it ("FHU ?US" never
    matches "FHUS"), which is why identity must come from evidence and search must be forgiving (P4.5, P5).

## Added in P4.5

24. **Every evidence rule needs a pass over its own output before anyone trusts it.** Each first cut of an
    edge rule was mostly right and partly badly wrong: "SERIES" became a $5B company, hedge-fund position ids
    merged Point72 with Schonfeld, a reused BlackRock id pulled all of DiDi into Ant, and a one-price
    coincidence joined two biotechs. Diff every re-seed against the last reviewed file, read the joins on
    private companies one by one, and turn each class of error into a rule and a test.
25. **Filer evidence can overturn a "look-alike" decision.** P4 kept "Anthropics Technology" and "OpenAir"
    apart as look-alikes (trap 26); the same instrument ids and marks showed they were BlackRock's labels for
    Anthropic and OpenAI (F31, F32). Name rules stay conservative; filer evidence decides, and it is shown to
    the user when it contradicts an earlier instruction.
26. **Check a derived test against a hand calculation.** "Exact to the cent" silently rejected real matching
    marks ($2,406,216.46 / 3,499 = $687.6869), and "three share classes in one filing" looked like an
    umbrella trust. Both surfaced only when a fixture case that should have an edge had none.
27. **A threshold must be measured before it is agreed.** "No unresolved component above $50M" over all
    holdings meant $300B+ of feeder-fund and PE-fund interests and ~140 single-fund positions. The ranked
    report by category turned it into a decision the user could make (2+ funds, 2026-09-30).

## Added in the pre-P5 review (2026-09-30)

28. **A result that depends on row order is not reproducible.** The identity graph read its rows without an
    `ORDER BY`, and its guarded unions keep the first edge that wins; a later run could join a vehicle group
    differently with no change in data (63 of 38,224 review-queue rows moved once it was ordered). Order
    every query that feeds a first-wins or guarded step.
29. **Test the edges of a row rule, not only the goldens.** "Value > 0" was right for exposure but made a
    fund that still reports a $0 position look like an exit (F34), and "value / balance" made a per-unit
    vehicle value look like a share price. Golden companies had neither case; the tracked list did.
30. **A shared constant or helper lives in one module.** Two different `VEHICLE_WORDS` and three copies of
    the same name helpers drifted apart silently; `lib/entities/names.js`, `keep-rule.js` and `values.js`
    now hold them.

## Added in Phase 5 planning (2026-09-30)

31. **Check a plan against the code and the data before it is signed off.** The first P5 plan read well but
    contradicted itself on real inputs: "fall back for names never seen" would have answered Pfizer from its
    restricted rows alone, "update fixtures, not assertions" would have kept v1's amendment double-count,
    and "stable ids" were stable only inside one warehouse file. Each sentence of a plan that names a
    behavior gets one query or one code read before sign-off.

## Added in Phase 5a (2026-09-30)

32. **Two answers to one question must share one definition, and a test must hold them equal.** The review queue
    took "each fund's latest filing" from its rows, the as-of engine from its filings; they agreed on every golden
    and disagreed by $2.26B elsewhere (trap 44). `company_stats` is now tested against `exposureAsOf` and every
    review-queue component against its entity.
33. **A cache key covers everything the answer depends on.** An ETag of the refresh id alone served a stale body
    after a code change (304 on the same data). It is now the refresh id plus the build. The browser check caught
    it, not the tests: look at the running app, not only the suite.
34. **Edit scripts must not put untrusted text in a `String.replace` replacement.** `$\``, `$&`and`$'` are
    patterns there; one corrupted a test file. Use a function replacer or slice-and-join (LESSONS 16, again).
35. **Record the machine's load with every latency number.** The same code measured p95 7 ms and 44 ms an hour apart
    (load average ~4 from other processes). Compare runs only on the same conditions, and check a "regression"
    against the previous commit before chasing it.

## Added in Phase 5b (2026-09-30)

36. **A stub hides the bug the real library would throw.** Every Excel export with a debt section had thrown in the
    browser ("Debt / Loans" is not a valid sheet name) while the tests passed against `XLSX = {}`. The export tests
    now load the page's own SheetJS and jsPDF versions and read the files back.
37. **Check each gate on its own before committing.** `node --test … | grep … && git commit` committed a broken module:
    the pipe's status was grep's, not the tests'. Run the suite, read the result, then commit.
38. **Run the whole LIVE suite at a checkpoint, not only the goldens.** Five LIVE UI tests had failed since P5a; one hid a
    real bug (outlier badges against split-restated peers). They were only run in 5b.
39. **A restatement that is right within a series is wrong across series.** Split-restating a fund's own marks onto its
    latest basis is what velocity needs; comparing that restated peer with another fund's older, as-filed mark
    invented a +200% outlier. Compare across funds as filed, at the same date.
40. **Measure the worst case, not only p95.** Every fund route had p95 under 50 ms while one real fund (26,219 loan rows
    in one filing, trap 45) returned 25 MB and took 67 s for returns. Look at max and payload size too, and bound
    answers by what the page shows.
41. **Reconcile a measurement before building on it.** The 2026q2 capital-row estimate (1,855) and the stored count
    (1,788) differed by 67; the difference was term loans the keep rule already stores. Explain every gap first.
