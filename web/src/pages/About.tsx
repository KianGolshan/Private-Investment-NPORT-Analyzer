import { useApi } from '../api/client';
import type { Envelope } from '../api/types';
import { longDate, num } from '../lib/format';

export interface WarehouseStats {
  filings: number;
  firstFilingDate: string | null;
  newestFilingDate: string | null;
  funds: number;
  privateCompanies: number;
  trackedCompanies: number;
  firms: number;
  newestReportDate: string | null;
}

const REPO = 'https://github.com/KianGolshan/Private-Investment-NPORT-Analyzer';
const doc = (path: string) => `${REPO}/blob/main/${path}`;

/** About the data: sources, rules and limits (P9). Counts come from the warehouse (/api/stats). */
export default function About() {
  const s = useApi<Envelope & { stats: WarehouseStats }>('/api/stats').data?.stats;
  return (
    <div class="stack prose">
      <div class="page-head">
        <div>
          <div class="eyebrow">About</div>
          <h1>About the data and methodology</h1>
          <p class="muted" style={{ margin: '4px 0 0' }}>
            Vantage shows the private companies that SEC-registered funds report holding, what each fund marks them at,
            and how those positions change, filing by filing. Every number links to the filing it comes from.
          </p>
        </div>
      </div>

      <section class="card">
        <div class="card-body">
          <h2>Sources</h2>
          <ul>
            <li>
              <strong>Form N-PORT</strong> (NPORT-P), the portfolio report registered funds file with the SEC. Vantage
              loads the SEC’s quarterly bulk N-PORT data sets from 2019Q4, when public N-PORT filing began, and each
              night catches up on filings made since the newest data set, from EDGAR.
            </li>
            <li>
              <strong>Form N-CEN</strong>, for each fund’s investment adviser. A fund belongs to the firm that advises
              it in its latest N-CEN, and that mapping is applied to every period.
            </li>
            {s && (
              <li>
                Today: {num(s.filings)} N-PORT filings from {num(s.funds)} funds, filed {longDate(s.firstFilingDate)} to{' '}
                {longDate(s.newestFilingDate)}; {num(s.privateCompanies)} private companies, {num(s.firms)} firms.
              </li>
            )}
          </ul>
        </div>
      </section>

      <section class="card">
        <div class="card-body">
          <h2>How the numbers are read</h2>
          <ul>
            <li>
              <strong>Fund calendars are staggered.</strong> Each fund files one N-PORT per fiscal quarter, within 60
              days of the quarter’s end, and only the quarter’s last month is made public. Some funds’ quarters end in
              Jan/Apr/Jul/Oct, others in Feb/May/Aug/Nov or Mar/Jun/Sep/Dec, so every holding shows its own mark date.
            </li>
            <li>
              <strong>As of a date</strong>, each fund counts with its latest filing on or before that date, and only if
              that filing is no more than 123 days old. A fund that stopped filing drops out instead of being counted
              forever. An amended filing replaces the original for its report date.
            </li>
            <li>
              <strong>Private</strong> means the company is private, from a reviewed company list. It does not mean
              fair-value Level 3: funds label real private holdings Level 1 or 2 too. After a company lists, its rows
              are not counted as private holdings.
            </li>
            <li>
              <strong>Marks</strong> are the fair values funds report. A per-share mark is the reported value divided by
              the reported number of shares, adjusted for known share splits. Marks are compared only at the same mark
              date.
            </li>
            <li>
              <strong>Changes</strong> are worded as the filings allow: first reported, added, reduced, no longer
              reported, reported at $0, mark moved. A change in value is split into position (shares) and mark (price).
              Vantage never guesses why a fund bought, sold or exited.
            </li>
          </ul>
        </div>
      </section>

      <section class="card">
        <div class="card-body">
          <h2>How it is checked</h2>
          <ul>
            <li>
              <strong>Golden numbers</strong>: figures verified by hand against the raw filings on EDGAR, with their
              accession numbers, are re-checked by the test suite and against this site after every deploy and every
              night (<a href={doc('docs/GOLDEN-NUMBERS.md')}>GOLDEN-NUMBERS</a>).
            </li>
            <li>
              <strong>Reconciliation with EDGAR</strong>, monthly: the filings stored are compared with EDGAR’s own
              indexes, and a sample is fetched again and compared value by value. On 2026-10-08: no stored filing was
              missing from EDGAR, and none of 300 re-fetched filings had changed.
            </li>
            <li>
              <strong>Refresh</strong>: new filings load every night as a new, validated version of the data; the{' '}
              <a href="/status">status page</a> shows how current it is.
            </li>
            <li>
              Rules, data traps and decisions are documented in the open:{' '}
              <a href={doc('docs/DATA-QUALITY.md')}>data quality</a>,{' '}
              <a href={doc('docs/ARCHITECTURE.md')}>architecture</a> and <a href={REPO}>source code</a>.
            </li>
          </ul>
        </div>
      </section>

      <section class="card">
        <div class="card-body">
          <h2>Known limits</h2>
          <ul>
            <li>
              Only what funds report: mutual funds, ETFs, closed-end and interval funds that file N-PORT. Venture funds,
              private funds and company cap tables are not in these filings, and neither are total share counts, so
              Vantage shows no company valuations.
            </li>
            <li>
              Marks arrive late: a quarter’s report can be filed up to 60 days after the quarter ends, so the newest
              marks describe a date a month or two back.
            </li>
            <li>
              Some holdings are held through vehicles that the filings do not name (a fund’s own SPV or feeder); those
              cannot be traced to a company and are left out.
            </li>
            <li>
              History is read with today’s reviewed company list: a company that has since listed drops out of earlier
              periods too.
            </li>
            <li>
              Share splits are recognized for standard ratios. An unusual exchange can show as a position change plus a
              mark move.
            </li>
            <li>Private credit (loans and debt) is not covered on this site.</li>
          </ul>
        </div>
      </section>

      <section class="card">
        <div class="card-body">
          <h2>Disclaimer and privacy</h2>
          <p>
            Vantage is an independent research tool built on public SEC filings. It is not affiliated with the SEC or
            any fund, and it is <strong>not investment advice</strong>. Figures are as reported by the funds and may
            contain their errors; check the linked filing before relying on any number.
          </p>
          <p>
            No accounts and no cookies. Your watchlist and display settings stay in your own browser. Visits may be
            counted with Cloudflare Web Analytics, which sets no cookies.
          </p>
        </div>
      </section>
    </div>
  );
}
