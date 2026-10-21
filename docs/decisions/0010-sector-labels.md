# 0010: Sector, industry and theme labels are reviewed decisions

**Status:** accepted, 2026-10-20 (P14). The user approved the plan ([plans/P14-sectors.md](../plans/P14-sectors.md)),
chose our own sector → industry taxonomy plus themes, and said the backfill is done in session, not through a paid
model ("so it's just cents, not $150").

## Context

The core questions ("how did AI companies' per-share marks move from Q1 to Q3 2026?", "biotech vs AI holdings over
time") need every private company labeled by industry. Checked on real filings:

- **N-PORT has no industry field.** Holdings carry names, ids, LEI, country, issuer type and asset category only.
- **Form D is not an industry source.** It covers 95 of 197 reviewed companies, only 34% of their value. Its groups
  are coarse ("Other Technology" for 43 companies), and name matching collides: a 2015 "Nuro" is filed as
  biotechnology (W0).
- **GICS is licensed; NAICS has no AI and puts AI labs and biotechs both in "R&D services."**

## Decision

1. **The taxonomy is ours, versioned in `data/review/taxonomy.json`.** It has 9 sectors and 41 industries; each
   company gets exactly one industry, so industries add up to sectors and sectors to Market's total. It also has 8
   themes (AI, Fintech, Defense tech, Climate, Crypto, Space, Robotics, Quantum); a company gets any number, so
   themes overlap and never add up.
   - "AI" is AI-native: the core product is an AI model or system, or the compute, chips or data platforms used to
     build and run models. Using AI inside another product does not count.
2. **Labels are reviewed decisions, with a confidence and a source, in `data/review/industries.csv`.** The file is
   keyed by company id, and the name must match the id. "Not yet classified" (a blank industry, confidence
   `unclear`) is a decision too.
   - The review import validates every row: unknown codes, an id/name mismatch, or a label on a fund interest each
     fail with the file and line.
   - Every job refuses a private operating company with no decision.
   - "Make this a company" records "not yet classified" for the company it adds.
3. **Labels group numbers and change none.** Every grouped total is built on the same answers as Market and the
   bridge (sectors add up to Market's operating-company total; Explore's sector rows add up to the total row).
   Screens say the labels are Vantage's, not filed facts.
4. **Current classification applies to all history.** A pivot moves the company's whole history. That is the
   index convention, and it avoids breaks in the series.
5. **The per-share mark index follows chains:** one fund's one security, consecutive filings at most 100 days
   apart, split-adjusted, and in force under the as-of rule.
   - A company's level is the median of its chains, so a step-up that funds report in different quarters
     (staggered calendars) counts once.
   - Chain-linked: each period's change is the median (and the value-weighted) return of the companies marked at both ends of the period, so a company first reported later joins without moving the level, and long windows keep a sample. A company's later chain is spliced in at the company's level. The index starts at 100 before the first period with 5 companies and 20 chains, and stops at a later period without them.
   - It is shown for the average company (each period's mean company return, winsorized at the 5th and 95th
     percentiles; the median is often 0 because many marks do not change) and value-weighted, and not shown below 5 companies and 20
     chains.
6. **Backfill and future names.** The backfill was labeled in session from the warehouse names, with web search to
   confirm. New names reach a person through the nightly watch report's "New names" section, which lists every
   company-like name newly over $1M in any number of funds. Any paid model is opt-in, cheap, and capped in cents.

## Consequences

- 559 + 13 private companies that never met the review bar ($50M in 2+ funds) were admitted ($9.2B at 2026-08-31).
  Market's operating-company total moved from $64.10B to $73.34B; every other company's value is unchanged to the
  cent.
- Labels are judgments. A wrong label moves value between groups, never in or out of the total. The confidence and
  note per company, and the taxonomy version on every export, make that visible.
