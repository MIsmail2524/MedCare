import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Network, X, Activity } from 'lucide-react';
import { DRUGS, defaultPatient, derivePhysiology, evaluateAlerts, getDrug, type Alert } from '@medcare/engine';
import { useTwins } from '../lib/twins';
import { Badge, Card, Field, PageHeader, Select, cx } from '../components/ui';
import { AlertList, TwinPicker } from '../components/clinical';

const RANK = { info: 1, moderate: 2, major: 3, contraindicated: 4 } as const;
const CELL = ['', 'bg-info-soft text-info', 'bg-warn-soft text-warn', 'bg-danger-soft text-danger', 'bg-danger text-white'];
const CELL_LABEL = ['', 'i', 'Mod', 'Maj', 'CI'];

export default function Interactions() {
  const { twins } = useTwins();
  const [twinId, setTwinId] = useState('');
  const [selected, setSelected] = useState<string[]>(['warfarin', 'amiodarone', 'clarithromycin', 'atorvastatin']);
  const patient = twins?.find((t) => t.id === twinId)?.data ?? defaultPatient();
  const phys = useMemo(() => derivePhysiology(patient), [patient]);
  const alerts = useMemo(() => evaluateAlerts(patient, phys, selected), [patient, phys, selected]);
  const pair = (a: string, b: string): number => {
    let s = 0;
    for (const al of alerts as Alert[]) if (al.drugs.includes(a) && al.drugs.includes(b)) s = Math.max(s, RANK[al.severity]);
    return s;
  };
  return (
    <div>
      <PageHeader icon={<Network className="size-5" />} title="Interaction & pharmacogenomic checker" description="Screens combinations for pharmacokinetic (CYP, P-gp, renal) and pharmacodynamic (QT, serotonergic, CNS, bleeding, nephrotoxic) interactions, then personalises with the twin’s genotype and organ function." />
      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <div className="flex flex-col gap-4">
          <Card title="Medication list">
            <div className="flex flex-col gap-3">
              <Field label="Patient context" htmlFor="tw"><TwinPicker id="tw" twins={twins} value={twinId} onChange={setTwinId} /></Field>
              <Field label="Add medicine" htmlFor="addm">
                <Select id="addm" value="" onChange={(e) => e.target.value && setSelected((s) => (s.length < 12 ? [...s, e.target.value] : s))}>
                  <option value="">Select…</option>
                  {DRUGS.filter((d) => !selected.includes(d.id)).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              </Field>
              <ul className="flex flex-wrap gap-1.5" aria-label="Selected medicines">
                {selected.map((id) => (
                  <li key={id}>
                    <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 py-1 pl-3 pr-1 text-sm">
                      {getDrug(id).name}
                      <button onClick={() => setSelected((s) => s.filter((x) => x !== id))} className="rounded-full p-0.5 text-muted hover:bg-danger-soft hover:text-danger" aria-label={`Remove ${getDrug(id).name}`}><X className="size-3.5" /></button>
                    </span>
                  </li>
                ))}
              </ul>
              {selected.length > 0 && (
                <Link to={`/app/simulate?drug=${selected[0]}`} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"><Activity className="size-4" /> Simulate exposure changes</Link>
              )}
            </div>
          </Card>
          <Card title="Metabolic profile">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-muted"><th className="pb-1 font-medium">Drug</th><th className="pb-1 font-medium">Cleared by</th><th className="pb-1 font-medium">Inhibits / induces</th></tr></thead>
                <tbody>
                  {selected.map((id) => {
                    const d = getDrug(id);
                    return (
                      <tr key={id} className="border-t border-line align-top">
                        <td className="py-1.5 pr-2 font-medium">{d.name}</td>
                        <td className="py-1.5 pr-2">{[d.pk.fe > 0.3 ? `renal ${Math.round(d.pk.fe * 100)}%` : '', ...d.metabolism.map((m) => `${m.pathway} ${Math.round(m.fm * 100)}%`)].filter(Boolean).join(', ') || '—'}</td>
                        <td className="py-1.5">
                          {d.inhibits.map((i) => <Badge key={'i' + i.pathway} tone="warn" className="mb-0.5 mr-0.5">⊣ {i.pathway} ({i.strength})</Badge>)}
                          {d.induces.map((i) => <Badge key={'u' + i.pathway} tone="info" className="mb-0.5 mr-0.5">↑ {i.pathway} ({i.strength})</Badge>)}
                          {!d.inhibits.length && !d.induces.length && '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {selected.length >= 2 && (
            <Card title="Interaction matrix" subtitle="Highest severity for each pair. Cells are labelled, not colour-only.">
              <div className="overflow-x-auto">
                <table className="border-separate border-spacing-1 text-xs">
                  <thead>
                    <tr>
                      <th />
                      {selected.map((id) => <th key={id} scope="col" className="h-24 align-bottom font-medium"><span className="inline-block -rotate-45 whitespace-nowrap">{getDrug(id).name.split(' ')[0]}</span></th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {selected.map((a) => (
                      <tr key={a}>
                        <th scope="row" className="pr-2 text-right font-medium">{getDrug(a).name.split(' ')[0]}</th>
                        {selected.map((b) => {
                          const s = a === b ? 0 : pair(a, b);
                          return (
                            <td key={b} title={a === b ? '' : `${getDrug(a).name} + ${getDrug(b).name}`} className={cx('size-10 rounded-md text-center font-semibold', a === b ? 'bg-surface-3' : s ? CELL[s] : 'bg-surface-2 text-muted')}>
                              {a === b ? '' : s ? CELL_LABEL[s] : '·'}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted">CI = contraindicated · Maj = major · Mod = moderate · i = informational · “·” = none detected</p>
            </Card>
          )}
          <Card title={`Findings (${alerts.length})`}>
            <AlertList alerts={alerts} empty={selected.length < 2 ? 'Add at least two medicines (or a twin with genotype/organ data) to screen.' : 'No interactions detected for this combination.'} />
          </Card>
        </div>
      </div>
    </div>
  );
}
