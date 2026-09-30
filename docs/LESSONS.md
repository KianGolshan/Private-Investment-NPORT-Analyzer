# Lessons Learned (P0–P4.5, 2026-09-27/30)

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
