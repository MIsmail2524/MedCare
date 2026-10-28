import { useMemo, useState } from 'react';
import { Radar, Download } from 'lucide-react';
import { SAFETY_ORGANS, signalGaps } from '@medcare/engine';
import { useSafetyKB, ORGAN_NAMES } from '../lib/safety';
import { downloadCsv } from '../lib/format';
import { Badge, Button, Callout, Card, PageHeader, Select, Skeleton, Stat, cx } from '../components/ui';
import { SearchInput } from '../components/clinical';

export default function Signals() {
  const { kb, error } = useSafetyKB();
  const [q, setQ] = useState('');
  const [organ, setOrgan] = useState('');
  const gaps = useMemo(() => (kb ? signalGaps(kb, 2, 25) : []), [kb]);
  if (error) return <Callout tone="danger" title="Knowledge base unavailable">{error}</Callout>;
  if (!kb) return <Skeleton className="h-96" />;
  const v = kb.validation;
  const drugs = kb.drugs.filter((d) => `${d.genericName} ${d.classes.join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  const shownGaps = gaps.filter((g) => !organ || g.organ === organ);
  return (
    <div>
      <PageHeader
        icon={<Radar className="size-5" />}
        title="Post-market safety signals"
        description="Compares what each FDA label warns about with what the FDA Adverse Event Reporting System (FAERS) actually receives — surfacing disproportionate, unlabelled signals for pharmacovigilance review and quantifying how well the twin’s liability model reproduces regulator decisions."
        actions={<Button variant="secondary" icon={<Download className="size-4" />} onClick={() => downloadCsv('medcare-signal-gaps.csv', [['drug', 'organ', 'PRR', 'reports', 'strength', 'top terms'], ...gaps.map((g) => [g.drug, g.organ, g.prr.toFixed(2), g.count, g.strength, g.terms.map((t) => t[0]).join('; ')])])}>Export signals</Button>}
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Labelled medicines" value={kb.drugs.length} sub={`${kb.drugs.filter((d) => d.boxed).length} with boxed warnings`} />
        <Stat label="FAERS reports (database)" value={kb.faersTotal ? `${(kb.faersTotal / 1e6).toFixed(1)} M` : '—'} sub={kb.faersUpdated ? `updated ${kb.faersUpdated}` : undefined} />
        <Stat label="Unlabelled signals" value={gaps.length} sub={`${gaps.filter((g) => g.strength === 'strong').length} strong (PRR ≥ 4, n ≥ 100)`} tone={gaps.length ? 'warn' : undefined} />
        <Stat label="Liability model AUROC" value={v ? v.macroAuroc.toFixed(2) : '—'} sub="leave-one-drug-out vs FDA labels" tone={v && v.macroAuroc >= 0.7 ? 'ok' : undefined} />
      </div>
      <div className="grid gap-6 2xl:grid-cols-[1.3fr_1fr]">
        <Card title="Label vs. post-market evidence" subtitle="Cell letter = label status (B boxed, W warning); colour = FAERS proportional reporting ratio" actions={<div className="w-56"><SearchInput value={q} onChange={setQ} placeholder="Filter medicines…" label="Filter medicines" /></div>}>
          <div className="max-h-[640px] overflow-auto">
            <table className="border-separate border-spacing-[2px] text-[11px]">
              <thead className="sticky top-0 bg-surface">
                <tr>
                  <th className="pr-2 text-left font-medium text-muted">Medicine</th>
                  {SAFETY_ORGANS.map((o) => <th key={o} scope="col" className="h-20 align-bottom font-medium text-muted"><span className="inline-block -rotate-45 whitespace-nowrap">{ORGAN_NAMES[o]}</span></th>)}
                </tr>
              </thead>
              <tbody>
                {drugs.map((d) => (
                  <tr key={d.name}>
                    <th scope="row" className="whitespace-nowrap pr-2 text-left font-medium">{d.genericName}</th>
                    {SAFETY_ORGANS.map((o) => {
                      const x = d.organs[o];
                      const sig = x.count >= 10 ? Math.min(1, Math.log2(Math.max(x.prr, 1)) / 3) : 0;
                      return (
                        <td
                          key={o}
                          title={`${d.genericName} · ${ORGAN_NAMES[o]}: label ${x.label === 2 ? 'boxed' : x.label === 1 ? 'warning' : 'none'}, PRR ${x.prr.toFixed(2)} (n=${x.count})`}
                          className={cx('size-7 rounded text-center font-bold', x.label === 0 && x.presence !== 'warnings' && ((x.presence === 'absent' && x.prr >= 2) || x.prr >= 4) && x.count >= 25 && 'ring-2 ring-[var(--s2)]')}
                          style={{ background: sig > 0 ? `rgba(227, 73, 72, ${0.12 + 0.75 * sig})` : 'var(--surface-2)', color: sig > 0.6 ? '#fff' : 'var(--fg-2)' }}
                        >
                          {x.label === 2 ? 'B' : x.label === 1 ? 'W' : ''}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-muted">Orange ring = disproportionate FAERS reporting (PRR ≥ 2, n ≥ 25) for an organ the label does not warn about. FAERS reports are spontaneous and unverified; disproportionality is a hypothesis, not proof of causation.</p>
        </Card>
        <div className="flex flex-col gap-6">
          <Card title="Unlabelled signal candidates" subtitle="Organ absent from the label (PRR ≥ 2) or only under Adverse Reactions (PRR ≥ 4); ranked by PRR × log(reports)" actions={<Select aria-label="Filter by organ" value={organ} onChange={(e) => setOrgan(e.target.value)} className="w-40 h-8 text-xs"><option value="">All organs</option>{SAFETY_ORGANS.map((o) => <option key={o} value={o}>{ORGAN_NAMES[o]}</option>)}</Select>}>
            {shownGaps.length === 0 ? <p className="text-sm text-muted">None at the current thresholds.</p> : (
              <ul className="max-h-[420px] divide-y divide-line overflow-y-auto">
                {shownGaps.slice(0, 60).map((g) => (
                  <li key={g.drug + g.organ} className="py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{g.drug} → {ORGAN_NAMES[g.organ]}</span>
                      <span className="flex gap-1"><Badge tone={g.presence === 'absent' ? 'danger' : 'neutral'}>{g.presence === 'absent' ? 'not in label' : 'adverse reactions only'}</Badge><Badge tone={g.strength === 'strong' ? 'danger' : 'warn'}>PRR {g.prr > 50 ? '> 50' : g.prr.toFixed(1)} · n {g.count}</Badge></span>
                    </div>
                    <p className="text-xs text-muted">{g.terms.slice(0, 4).map(([t, c]) => `${t.toLowerCase()} (${c})`).join(', ')}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {v && (
            <Card title="Does the twin reproduce regulator decisions?" subtitle={v.method}>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Organ</th><th className="pb-1 font-medium">Labelled drugs</th><th className="pb-1 font-medium">AUROC</th><th className="pb-1 font-medium">AUPRC (base)</th></tr></thead>
                <tbody>
                  {v.organs.map((m) => (
                    <tr key={m.organ} className="border-t border-line tabular">
                      <td className="py-1">{ORGAN_NAMES[m.organ]}</td>
                      <td>{m.positives}</td>
                      <td className={cx(m.auroc >= 0.75 ? 'font-semibold text-ok' : m.auroc < 0.6 ? 'text-warn' : '')}>{Number.isFinite(m.auroc) ? m.auroc.toFixed(2) : '—'}</td>
                      <td>{Number.isFinite(m.auprc) ? m.auprc.toFixed(2) : '—'} <span className="text-muted">({m.baseRate.toFixed(2)})</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mb-1 mt-4 text-xs font-medium text-fg-2">Calibration (predicted vs observed label rate, deciles)</p>
              <div className="flex h-28 items-end gap-1" role="img" aria-label="Calibration chart">
                {v.calibration.map((c, i) => (
                  <div key={i} className="relative h-full flex-1" title={`predicted ${c.predicted.toFixed(2)} · observed ${c.observed.toFixed(2)} (n=${c.n})`}>
                    <div className="absolute inset-x-0 bottom-0 rounded-t-[3px] bg-[var(--s1)]" style={{ height: `${c.observed * 100}%` }} />
                    <div className="absolute inset-x-0 h-0.5 bg-[var(--s2)]" style={{ bottom: `${c.predicted * 100}%` }} />
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted">Bars: observed rate of label warnings; orange tick: mean predicted probability.</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
