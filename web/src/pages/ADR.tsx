import { useEffect, useMemo, useState } from 'react';
import { Stethoscope, Plus, Trash2, Search, ShieldAlert } from 'lucide-react';
import { assessCausality, defaultPatient, DRUGS, getDrug, ORGAN_SYMPTOMS, SAFETY_ORGANS, type ADRMedication, type CausalityResult, type Organ } from '@medcare/engine';
import { useTwins } from '../lib/twins';
import { useSafetyKB, ORGAN_NAMES } from '../lib/safety';
import { fmtHours, uid } from '../lib/format';
import { Badge, Button, Callout, Card, Field, Input, PageHeader, Select, cx } from '../components/ui';
import { TwinPicker } from '../components/clinical';
import { TimeChart } from '../components/charts';

type Row = ADRMedication & { id: string };
const toLocal = (iso: string) => iso.slice(0, 16);
const nowLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export default function ADR() {
  const { twins } = useTwins();
  const { kb } = useSafetyKB();
  const [twinId, setTwinId] = useState('');
  const patient = useMemo(() => twins?.find((t) => t.id === twinId)?.data ?? defaultPatient(), [twins, twinId]);
  const [rows, setRows] = useState<Row[]>([]);
  const [organ, setOrgan] = useState<Organ>('kidneys');
  const [onset, setOnset] = useState(nowLocal());
  const [severity, setSeverity] = useState<'mild' | 'moderate' | 'severe' | 'life-threatening'>('moderate');
  const [add, setAdd] = useState('');
  const [result, setResult] = useState<CausalityResult | null>(null);

  useEffect(() => {
    const t = twins?.find((x) => x.id === twinId);
    if (t) {
      setRows(t.data.medicationHistory.map((m) => ({ id: m.id, name: getDrug(m.drugId).name.split(' (')[0].toLowerCase(), drugId: m.drugId, start: toLocal(m.start), end: m.end && new Date(m.end).getTime() < Date.now() - 86400000 ? toLocal(m.end) : undefined, dose: m.dose, intervalH: m.intervalH })));
    } else {
      const start = new Date(Date.now() - 7 * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      setRows([
        { id: 'a', name: 'vancomycin', drugId: 'vancomycin', start, dose: 1500, intervalH: 12 },
        { id: 'b', name: 'ibuprofen', drugId: 'ibuprofen', start, dose: 400, intervalH: 8 },
        { id: 'c', name: 'omeprazole', drugId: 'omeprazole', start: new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 16), dose: 20, intervalH: 24 },
      ]);
    }
    setResult(null);
  }, [twins, twinId]);

  const options = useMemo(() => {
    const pk = DRUGS.map((d) => ({ key: `pk:${d.id}`, label: `${d.name} (PK model)` }));
    const pkNames = new Set(DRUGS.map((d) => d.id));
    const kbOnly = (kb?.drugs ?? []).filter((d) => !pkNames.has(d.name)).map((d) => ({ key: `kb:${d.name}`, label: d.genericName }));
    return [...pk, ...kbOnly].sort((a, b) => a.label.localeCompare(b.label));
  }, [kb]);

  const run = () => {
    const meds = rows.map(({ id: _id, ...m }) => ({ ...m, start: new Date(m.start).toISOString(), end: m.end ? new Date(m.end).toISOString() : undefined }));
    setResult(assessCausality(patient, { organ, onset: new Date(onset).toISOString(), severity }, meds, kb));
  };

  return (
    <div>
      <PageHeader
        icon={<Stethoscope className="size-5" />}
        title="ADR detective"
        description="When a patient develops a possible side effect, the twin reconstructs every medicine’s exposure up to the moment of onset and ranks the suspects — combining label and FAERS evidence, organ-specific onset latency, the simulated drug level at onset and interaction-driven exposure — then proposes management and simulates what happens if the culprit is stopped."
      />
      <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
        <div className="flex flex-col gap-4">
          <Card title="1. Patient">
            <Field label="Twin" htmlFor="tw"><TwinPicker id="tw" twins={twins} value={twinId} onChange={setTwinId} /></Field>
          </Card>
          <Card title="2. Adverse event">
            <div className="flex flex-col gap-3">
              <Field label="Organ system / presentation" htmlFor="org">
                <Select id="org" value={organ} onChange={(e) => setOrgan(e.target.value as Organ)}>
                  {SAFETY_ORGANS.map((o) => <option key={o} value={o}>{ORGAN_NAMES[o]} — {ORGAN_SYMPTOMS[o][0].toLowerCase()}</option>)}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Onset" htmlFor="on"><Input id="on" type="datetime-local" value={onset} onChange={(e) => setOnset(e.target.value)} /></Field>
                <Field label="Severity" htmlFor="sev">
                  <Select id="sev" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
                    <option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option><option value="life-threatening">Life-threatening</option>
                  </Select>
                </Field>
              </div>
            </div>
          </Card>
          <Card title="3. Medicines taken">
            <ul className="flex flex-col gap-2">
              {rows.map((r) => (
                <li key={r.id} className="rounded-xl border border-line p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium capitalize">{r.name}{r.drugId ? '' : ' · label/FAERS only'}</span>
                    <button className="text-muted hover:text-danger" aria-label={`Remove ${r.name}`} onClick={() => setRows(rows.filter((x) => x.id !== r.id))}><Trash2 className="size-4" /></button>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Input aria-label={`${r.name} start`} type="datetime-local" value={r.start} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, start: e.target.value } : x)))} />
                    <Input aria-label={`${r.name} stop (blank = ongoing)`} type="datetime-local" value={r.end ?? ''} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, end: e.target.value || undefined } : x)))} />
                    {r.drugId && (
                      <>
                        <Input aria-label={`${r.name} dose mg`} type="number" min={0} value={r.dose ?? ''} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, dose: Number(e.target.value) } : x)))} />
                        <Input aria-label={`${r.name} interval h`} type="number" min={1} value={r.intervalH ?? ''} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, intervalH: Number(e.target.value) } : x)))} />
                      </>
                    )}
                  </div>
                  <p className="mt-1 text-[10px] text-muted">start · stop (blank = ongoing){r.drugId ? ' · dose mg · interval h' : ''}</p>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <Select aria-label="Add medicine" value={add} onChange={(e) => setAdd(e.target.value)}>
                <option value="">Add a medicine…</option>
                {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </Select>
              <Button variant="secondary" icon={<Plus className="size-4" />} disabled={!add} onClick={() => {
                const [kind, id] = add.split(':');
                const start = new Date(new Date(onset).getTime() - 10 * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
                if (kind === 'pk') {
                  const d = getDrug(id);
                  setRows([...rows, { id: uid('r'), name: d.name.split(' (')[0].toLowerCase(), drugId: d.id, start, dose: d.defaultRegimen.unit === 'mg' ? d.defaultRegimen.dose : d.defaultRegimen.dose * 70, intervalH: d.defaultRegimen.intervalH }]);
                } else setRows([...rows, { id: uid('r'), name: id, start }]);
                setAdd('');
              }}>Add</Button>
            </div>
          </Card>
          <Button icon={<Search className="size-4" />} onClick={run} disabled={!rows.length}>Find the likely culprit</Button>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {!result ? (
            <Callout tone="info" title="Model-based causality assessment">Unlike questionnaire scores (Naranjo, RUCAM), the twin uses each drug’s simulated concentration at onset, its washout, interaction-driven exposure changes and organ-specific latency windows, weighted by the drug’s FDA-label and FAERS liability for the affected organ.</Callout>
          ) : (
            <>
              <Card title={`Suspect ranking — ${ORGAN_NAMES[result.event.organ]} event`} subtitle={`Probability that a non-drug cause explains it: ${Math.round(result.otherCauses * 100)}%`}>
                <ul className="flex flex-col gap-3">
                  {result.candidates.map((c, i) => (
                    <li key={c.name} className={cx('rounded-xl border p-3', i === 0 && c.category !== 'unlikely' ? 'border-danger/40 bg-danger-soft/40' : 'border-line')}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-semibold capitalize">{c.name}</p>
                        <span className="flex items-center gap-2">
                          <Badge tone={c.category === 'probable' ? 'danger' : c.category === 'possible' ? 'warn' : 'neutral'}>{c.category}</Badge>
                          <span className="text-lg font-semibold tabular">{Math.round(c.posterior * 100)}%</span>
                        </span>
                      </div>
                      <div className="mt-2 grid grid-cols-4 gap-2 text-[11px]">
                        {([['Organ liability', c.factors.prior], ['Timing', c.factors.temporal], ['Exposure', c.factors.exposure], ['Interaction', Math.min(c.factors.interaction / 1.8, 1)]] as const).map(([k, val]) => (
                          <div key={k}>
                            <p className="text-muted">{k}</p>
                            <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-surface-3"><div className="h-full rounded bg-[var(--s1)]" style={{ width: `${Math.min(1, val) * 100}%` }} /></div>
                          </div>
                        ))}
                      </div>
                      <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-fg-2">{c.explanation.map((e) => <li key={e}>{e}</li>)}</ul>
                    </li>
                  ))}
                </ul>
              </Card>
              <div className="grid gap-4 2xl:grid-cols-2">
                <Card title={<span className="flex items-center gap-2"><ShieldAlert className="size-4 text-danger" aria-hidden />Management plan</span>}>
                  <ol className="list-decimal space-y-1.5 pl-5 text-sm text-fg-2">{result.management.map((m) => <li key={m}>{m}</li>)}</ol>
                </Card>
                {result.dechallenge && (
                  <Card title={`Dechallenge simulation — ${getDrug(result.dechallenge.drugId).name}`} subtitle={result.dechallenge.hoursToBelowThreshold !== null ? `Stopping now brings the level below half the toxic threshold in ≈ ${fmtHours(result.dechallenge.hoursToBelowThreshold)}` : 'Projected concentrations if continued vs stopped at onset'}>
                    <TimeChart
                      ariaLabel="Dechallenge simulation"
                      t={result.dechallenge.t}
                      unit={result.dechallenge.unit}
                      height={220}
                      toxic={result.dechallenge.threshold !== null ? { value: result.dechallenge.threshold, label: 'toxic' } : undefined}
                      series={[
                        { def: { key: 'c', label: 'Continue', color: 'var(--s8)' }, values: result.dechallenge.continued },
                        { def: { key: 's', label: 'Stop now', color: 'var(--s3)' }, values: result.dechallenge.stopped },
                      ]}
                    />
                  </Card>
                )}
              </div>
              <p className="text-xs text-muted">Decision support for education and research — confirm with clinical assessment. Report suspected ADRs to your pharmacovigilance authority.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
