import { useMemo } from 'preact/hooks';
import { qs, useApi } from '../../api/client';
import type { Exposure, FactLeg, Holding, LegsAt, Position } from '../../api/types';
import {
  firmPath,
  fundPath,
  longDate,
  moneyC,
  moneyDelta,
  num,
  pctOfNav,
  price,
  signedNum,
  tone,
} from '../../lib/format';
import { ScopeBar } from '../../scope/ScopeBar';
import { scopeParams, useParam, useScope } from '../../scope/scope';
import { Card, ErrorBox, FilingRef, Kpi, Loading, Segmented } from '../../ui/bits';
import { DataTable, type Column, type Group } from '../../ui/DataTable';
import { FilterPickers, KindBadge, firmNames, kindText, useFilterOptions, type ViewProps } from './shared';

// Holders as of a date, within the scope (the server filters), each position
// with its fund's change since the fund's previous filing: shares, position
// effect and mark effect (the position facts' legs in force at the date).

interface PosRow extends Position {
  h: Holding;
  leg: (FactLeg & { fundKey: string }) | null;
  /** The class's other keys merged into one change (trap 52), when this row is one of them. */
  mergedInto: string | null;
}

type GroupBy = 'none' | 'firm' | 'fund';

export default function Holders({ base, sq, name, newest, openPosition }: ViewProps) {
  const [scope] = useScope();
  const [groupParam, setGroup] = useParam('group');
  const groupBy: GroupBy = groupParam === 'firm' || groupParam === 'fund' ? groupParam : 'none';
  const opts = useFilterOptions(base, sq);
  const filters = scopeParams(scope);
  const exp = useApi<Exposure>(`${base}/exposure${qs({ date: scope.asof, ...sq, ...filters })}`);
  const legs = useApi<LegsAt>(`${base}/legs${qs({ date: scope.asof, ...sq, ...filters })}`);
  const d = exp.data;

  const rows = useMemo(() => {
    const byKey = new Map<string, FactLeg & { fundKey: string }>();
    const merged = new Map<string, string>();
    for (const l of legs.data?.legs ?? []) {
      byKey.set(`${l.fundKey}|${l.instrumentKey}`, l);
      for (const k of l.mergedKeys ?? []) merged.set(`${l.fundKey}|${k}`, l.instrumentKey);
    }
    const out: PosRow[] = [];
    for (const h of d?.holdings ?? [])
      for (const p of h.positions ?? []) {
        const k = `${h.fundKey}|${p.instrumentKey}`;
        out.push({ ...p, h, leg: byKey.get(k) ?? null, mergedInto: merged.get(k) ?? null });
      }
    return out;
  }, [d, legs.data]);

  const effects = useMemo(() => {
    const t = { position: 0, mark: 0 };
    for (const l of legs.data?.legs ?? []) {
      t.position += l.positionEffect + l.otherEffect;
      t.mark += l.markEffect;
    }
    return t;
  }, [legs.data]);

  const deltaCell = (r: PosRow, v: (l: FactLeg) => number, fmt: (n: number) => string) => {
    if (r.mergedInto)
      return (
        <span class="muted small" title="One class across keys (trap 52)">
          in {r.mergedInto}
        </span>
      );
    if (!r.leg) return <span class="muted">—</span>;
    if (r.leg.event === 'firstFiling' || r.leg.event === 'resumed' || r.leg.change === 'new class')
      return <span class="muted small">{r.leg.change === 'new class' ? 'new' : r.leg.label}</span>;
    const n = v(r.leg);
    return <span class={tone(n)}>{fmt(n)}</span>;
  };

  const columns: Column<PosRow>[] = [
    {
      id: 'fund',
      header: 'Fund',
      value: r => r.h.fundLabel || r.h.seriesName || r.h.registrant,
      render: r => (
        <span>
          <a href={fundPath(r.h.fundKey)}>{r.h.fundLabel || r.h.seriesName}</a>{' '}
          <button
            class="btn sm ghost"
            type="button"
            title="Position history"
            aria-label={`Position history of ${r.h.fundLabel || r.h.seriesName}`}
            onClick={e => {
              e.stopPropagation();
              openPosition(r.h.fundKey);
            }}
          >
            ⧉
          </button>
        </span>
      ),
      exportAs: [
        { header: 'Fund key', value: r => r.h.fundKey },
        { header: 'Registrant', value: r => r.h.registrant },
      ],
      wrap: true,
    },
    {
      id: 'firm',
      header: 'Firm',
      value: r => firmNames(r.h.firms),
      render: r =>
        r.h.firms?.length ? (
          <span class="small">
            {r.h.firms.map((f, i) => (
              <span key={f.id}>
                {i > 0 && ' / '}
                <a href={firmPath(f.id)}>{f.name}</a>
              </span>
            ))}
          </span>
        ) : (
          <span class="muted">—</span>
        ),
      title: 'The fund’s adviser on its latest N-CEN',
    },
    {
      id: 'markDate',
      header: 'Mark date',
      value: r => r.h.markDate,
      render: r => <FilingRef cik={r.h.cik} accession={r.h.accession} date={r.h.markDate} />,
      exportAs: [{ header: 'Accession', value: r => r.h.accession }],
    },
    {
      id: 'class',
      header: 'Class',
      value: r => r.classLabel,
      render: r => (
        <span title={r.title}>
          {r.classLabel} <KindBadge kind={r.kind} />
        </span>
      ),
      exportAs: [
        { header: 'Title', value: r => r.title },
        { header: 'Instrument key', value: r => r.instrumentKey },
        { header: 'Asset category', value: r => r.assetCat },
        { header: 'Held', value: r => kindText(r.kind) },
      ],
    },
    {
      id: 'shares',
      header: 'Shares / units',
      value: r => r.balance,
      num: true,
      render: r => num(r.balance),
      exportAs: [{ header: 'Unit', value: r => r.unit }],
    },
    {
      id: 'price',
      header: 'Mark',
      value: r => r.pricePerShare ?? r.pricePerUnit,
      num: true,
      render: r => price(r.pricePerShare ?? r.pricePerUnit, r.unit),
    },
    { id: 'value', header: 'Value', value: r => r.valueUsd, num: true, render: r => moneyC(r.valueUsd) },
    {
      id: 'pctNav',
      header: '% of fund',
      value: r => r.pctNav,
      num: true,
      render: r => pctOfNav(r.pctNav),
      title: 'Percent of the fund’s net assets, as filed',
    },
    {
      id: 'since',
      header: 'Since',
      value: r => r.leg?.prevMarkDate ?? null,
      render: r => (r.leg?.prevMarkDate ? <span class="small">{r.leg.prevMarkDate}</span> : '—'),
      title: 'The fund’s previous filing, which the change columns compare with',
    },
    {
      id: 'dShares',
      header: 'Δ shares',
      value: r =>
        r.leg && r.leg.balance != null && r.leg.prevBalance != null
          ? r.leg.balance - r.leg.prevBalance * (r.leg.split ?? 1)
          : null,
      title: 'Shares now minus shares at the prior filing (restated for a detected split)',
      num: true,
      render: r => deltaCell(r, l => (l.balance ?? 0) - (l.prevBalance ?? 0) * (l.split ?? 1), signedNum),
    },
    {
      id: 'dPos',
      header: 'Position Δ',
      value: r => r.leg?.positionEffect ?? null,
      num: true,
      render: r => deltaCell(r, l => l.positionEffect + l.otherEffect, moneyDelta),
      title: 'Shares added or removed at the prior mark (rows with no share count: their value change)',
    },
    {
      id: 'dMark',
      header: 'Mark Δ',
      value: r => r.leg?.markEffect ?? null,
      num: true,
      render: r => deltaCell(r, l => l.markEffect, moneyDelta),
      title: 'The new mark on the shares held',
    },
    { id: 'level', header: 'FV level', value: r => r.fvLevel, num: true },
  ];

  const group: Group<PosRow> | undefined =
    groupBy === 'none'
      ? undefined
      : {
          key: r => (groupBy === 'firm' ? firmNames(r.h.firms) : r.h.fundLabel || r.h.seriesName || r.h.fundKey),
          header: (k, rs) => (
            <span>
              <strong>{k}</strong>{' '}
              <span class="muted small">
                {new Set(rs.map(r => r.h.fundKey)).size} funds · {moneyC(rs.reduce((s, r) => s + (r.valueUsd || 0), 0))}
              </span>
            </span>
          ),
        };

  const others = (list: Holding[] | undefined, title: string, note: string) =>
    list && list.length > 0 ? (
      <Card title={`${title} (${list.length})`} actions={<span class="muted small">{note}</span>} flush>
        <DataTable
          columns={[
            {
              id: 'fund',
              header: 'Fund',
              value: (h: Holding) => h.fundLabel || h.seriesName || h.registrant,
              render: (h: Holding) => <a href={fundPath(h.fundKey)}>{h.fundLabel || h.seriesName}</a>,
              wrap: true,
            },
            { id: 'firm', header: 'Firm', value: (h: Holding) => firmNames(h.firms) },
            {
              id: 'mark',
              header: 'Latest filing',
              value: (h: Holding) => h.markDate,
              render: (h: Holding) => <FilingRef cik={h.cik} accession={h.accession} date={h.markDate} />,
              exportAs: [{ header: 'Accession', value: (h: Holding) => h.accession }],
            },
            {
              id: 'last',
              header: 'Last reported holding',
              value: (h: Holding) => h.lastHeldDate,
              render: (h: Holding) => <FilingRef cik={h.cik} accession={h.lastHeldAccession} date={h.lastHeldDate} />,
              exportAs: [{ header: 'Last holding accession', value: (h: Holding) => h.lastHeldAccession }],
            },
          ]}
          rows={list}
          rowKey={h => h.fundKey}
          sort={{ id: 'last', desc: true }}
          exportName={`${name}-${title}`}
          onRowClick={h => openPosition(h.fundKey)}
        />
      </Card>
    ) : null;

  return (
    <div class="stack">
      <div class="row wrap">
        <ScopeBar
          supports={{ asof: true, filters: ['firm', 'fund', 'class', 'kind'] }}
          newest={newest}
          fundName={opts.fundName}
        />
        <FilterPickers firms={opts.firms} classes={opts.classes} kinds={opts.indirect} />
        <span class="spacer" />
        <Segmented
          label="Group rows"
          value={groupBy}
          onChange={v => setGroup(v === 'none' ? '' : v, { replace: true })}
          options={[
            { id: 'none', label: 'Positions' },
            { id: 'firm', label: 'By firm' },
            { id: 'fund', label: 'By fund' },
          ]}
        />
      </div>
      <ErrorBox error={exp.error || legs.error} />
      {exp.loading && !d && <Loading rows={6} />}
      {d && (
        <>
          <div class="kpis">
            <Kpi label="Funds holding" value={num(d.funds)} sub={`as of ${longDate(d.date)}`} />
            <Kpi label="Value" value={moneyC(d.total)} sub="each fund at its own mark date" />
            <Kpi label="Positions" value={num(rows.length)} sub="fund × share class rows" />
            <Kpi
              label="Since each fund’s prior filing"
              value={
                <span>
                  <span class={tone(effects.position)}>{moneyDelta(effects.position)}</span>
                  <span class="muted small"> position · </span>
                  <span class={tone(effects.mark)}>{moneyDelta(effects.mark)}</span>
                  <span class="muted small"> mark</span>
                </span>
              }
              sub="the latest filings’ changes"
            />
            <Kpi label="No longer reported" value={num(d.exited.length)} sub="funds, since their last holding" />
          </div>
          <Card title={`Holders as of ${longDate(d.date)}`} flush>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={r => `${r.h.fundKey}:${r.rowKey}`}
              sort={{ id: 'value', desc: true }}
              group={group}
              exportName={`${name}-holders-${d.date}`}
              filterPlaceholder="Filter funds, firms or classes…"
              maxHeight={620}
              totals={rs => ({ fund: 'Total', value: moneyC(rs.reduce((s, r) => s + (r.valueUsd || 0), 0)) })}
            />
          </Card>
          {d.disclosedExposure.length > 0 && (
            <Card title="Disclosed without naming vehicles">
              <ul>
                {d.disclosedExposure.map(x => (
                  <li key={x.fundKey + x.markDate}>
                    <a href={fundPath(x.fundKey)}>{x.seriesName || x.registrant || x.fundKey}</a>: “{x.basis}” (
                    {x.markDate}, <span class="mono">{x.accession}</span>)
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {others(d.zeroValue, 'Reported at $0', 'still reported, valued at $0')}
          {others(d.exited, 'No longer reported', 'the fund’s latest filing has no row for the company')}
          {others(d.inactive, 'Fund stopped filing', 'no N-PORT within 123 days of the date')}
        </>
      )}
    </div>
  );
}
