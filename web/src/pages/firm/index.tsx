import { useRoute } from 'preact-iso';
import { qs, useApi } from '../../api/client';
import type { FirmBook, Freshness } from '../../api/types';
import { longDate, moneyC, num } from '../../lib/format';
import { useParam, useScope } from '../../scope/scope';
import { ErrorBox, Kpi, Loading, Tabs } from '../../ui/bits';
import { BookOverview } from '../book/BookOverview';
import { MarksVsOthers } from '../book/MarksVsOthers';
import { Timeline } from '../book/Timeline';
import { Book } from './Book';
import { FirmChanges } from './Changes';

// A manager (P6b W3): every fund it advises (current N-CEN adviser). Overview
// (its private book over time and the bridge for a range), the investment
// timeline, the book as of a date (by company, by fund, company × fund),
// its marks against other firms' at the same mark date, and its changes.

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'book', label: 'Book' },
  { id: 'marks', label: 'Marks vs others' },
  { id: 'changes', label: 'Changes' },
];

export default function Firm() {
  const { params } = useRoute();
  const id = Number(params.id);
  const [scope] = useScope();
  const [tab, setTab] = useParam('tab');
  // The old book tabs (?tab=companies|funds) open the book.
  const current = tab === 'companies' || tab === 'funds' ? 'book' : TABS.some(t => t.id === tab) ? tab : 'overview';
  const fresh = useApi<Freshness>('/api/freshness');
  const book = useApi<FirmBook>(Number.isInteger(id) ? `/api/firms/${id}${qs({ date: scope.asof })}` : null);
  const b = book.data;
  const newest = fresh.data?.newestReportDate ?? null;
  return (
    <div class="stack">
      <ErrorBox error={book.error} />
      {book.loading && !b && <Loading rows={4} />}
      {b && (
        <>
          <div class="page-head">
            <div>
              <div class="eyebrow">Firm</div>
              <h1>{b.firm.name}</h1>
              <p class="muted" style={{ margin: '4px 0 0' }}>
                {num(b.firm.fundsManaged)} funds advised
                {b.firm.fundsSubadvised ? `, ${num(b.firm.fundsSubadvised)} sub-advised (not in the book)` : ''}; firm =
                the fund’s current N-CEN adviser. Each fund at its own mark date.
              </p>
            </div>
          </div>
          <div class="kpis">
            <Kpi label="Private value" value={moneyC(b.value)} sub={`as of ${longDate(b.date)}`} />
            <Kpi label="Companies" value={num(b.companies)} />
            <Kpi label="Funds holding" value={num(b.byFund.length)} />
            <Kpi label="Largest" value={b.byCompany[0]?.name ?? '—'} sub={moneyC(b.byCompany[0]?.value)} />
          </div>
          <Tabs tabs={TABS} current={current} onSelect={t => setTab(t === 'overview' ? '' : t)} />
          {current === 'overview' && <BookOverview who={{ firm: id }} name={b.firm.name} newest={newest} />}
          {current === 'timeline' && <Timeline who={{ firm: id }} name={b.firm.name} />}
          {current === 'book' && <Book id={id} book={b} newest={newest} />}
          {current === 'marks' && <MarksVsOthers who={{ firm: id }} name={b.firm.name} newest={newest} />}
          {current === 'changes' && <FirmChanges id={id} name={b.firm.name} newest={newest} />}
        </>
      )}
    </div>
  );
}
