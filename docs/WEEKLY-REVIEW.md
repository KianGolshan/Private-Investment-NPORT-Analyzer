# Weekly review: new private companies

Once a week a Claude Code session works through what the nightly watch reports found since the last review, so
new private companies reach Market and Sectors with an industry. It is run by the scheduled task
`vantage-weekly-review` (the Claude desktop app, Mondays). Labels are made in the session from the filings and web
evidence. **Never call a paid model API for this** (the user's rule; CLAUDE.md, ADR 0010).

The log of past reviews is [reviews/LOG.md](reviews/LOG.md); each review's notes are in `docs/reviews/<date>.md`.

## 1. Get the live data and the reports

The server (`ssh ubuntu@129.146.24.191`, key on the user's Mac) keeps a verified backup each night and a watch
report each night:

```bash
ssh ubuntu@129.146.24.191 'sudo ls -t /var/lib/vantage/backups/*.db | head -1'
ssh ubuntu@129.146.24.191 'sudo ls /var/lib/vantage/reports/watch/'
```

- Copy every `reports/watch/<date>.json` and `.md` dated after the last review in `docs/reviews/LOG.md` to the
  scratchpad (`sudo cat … > file`).
- Copy the newest backup and its `.sha256` to the scratchpad (about 600 MB; `sudo cat` over ssh, then check the
  SHA-256), and restore it locally so the local warehouse equals the live one:
  `npm run backup -- --restore <file>` (one job, in the foreground; nothing else running).
- Start from `main` (`git checkout main && git pull`) on a new branch `review/<date>`.

## 2. Work the lists (sections of the watch report)

| Section                     | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New names** (over $1M)    | Decide what each is: a private operating company, an existing company under another name, a fund or vehicle, a listed stock, or unclear. Check the raw rows (`node scripts/verify-edgar.js`), the issuer name, LEI and title, and the web when the name is unclear. A private operating company: `node scripts/make-company.js --key "<key>" --name "<clean name>"`. Another name of an existing company: add the key to that company's rows in `data/review/aliases.csv`. Anything else: note it, no change. |
| **Not yet classified**      | Give each an industry and themes from `data/review/taxonomy.json` in `data/review/industries.csv` (confidence high, medium or low, and a short note with the evidence). Leave "unclear" only for a code name with no public footprint.                                                                                                                                                                                                                                                                        |
| **Review queue** ($50M, 2+) | As for new names.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Listing evidence**        | A private company held as listed stock: check whether it listed (ADR 0008). Change status only with listing evidence.                                                                                                                                                                                                                                                                                                                                                                                         |
| **Identity, split ids**     | Link or split only with high-confidence evidence (same instrument id and share count); otherwise note it.                                                                                                                                                                                                                                                                                                                                                                                                     |

Rules (CLAUDE.md): real SEC data only; SpaceX is public; group by identity, never by name alone; never renumber an
id; every new company gets an industry decision ("not yet classified" counts). Then run the import once:
`npm run review:aliases`.

## 3. Check and ship

- `npm test`, `npm run lint`, `npm run format:check` (one at a time).
- Spot-check: Market and Sectors totals equal at the newest date; each new company's value equals its raw rows.
- Write `docs/reviews/<date>.md` (each name, the decision, the evidence accession) and add a line to
  `docs/reviews/LOG.md`.
- Commit, push, open a PR to `main` (main is protected; the merge deploys, and the server re-imports `data/review`).
  The user merges it.
- When nothing needs a change, open no PR: the next review reads the reports from the same start date.
