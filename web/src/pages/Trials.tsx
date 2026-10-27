import { useEffect, useMemo, useRef, useState } from 'react';
import { FlaskConical, Play, Plus, Trash2, Download, Square } from 'lucide-react';
import { DEFAULT_POPULATION, getDrug, makeRegimen, PHENOTYPE_FREQ, type Ancestry, type ArmResult, type PopulationSpec, type Regimen, type TrialArm } from '@medcare/engine';
import { post } from '../lib/api';
import { useToast } from '../lib/toast';
import { downloadCsv, fmt, uid } from '../lib/format';
import { Badge, Button, Callout, Card, Field, Input, NumberField, PageHeader, Select, Stat, cx } from '../components/ui';
import { DrugSelect, RegimenEditor } from '../components/clinical';
import { BandChart, Histogram } from '../components/charts';

const ARM_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)'];

export default function Trials() {
  const toast = useToast();
  const [spec, setSpec] = useState<PopulationSpec>({ ...DEFAULT_POPULATION });
  const [drugId, setDrugId] = useState('vancomycin');
  const [arms, setArms] = useState<{ id: string; label: string; regimens: Regimen[] }[]>([
    { id: 'a', label: 'Standard 1 g q12h', regimens: [makeRegimen('vancomycin', { doses: 6 })] },
    { id: 'b', label: '15 mg/kg q12h', regimens: [makeRegimen('vancomycin', { dose: 15, unit: 'mg/kg', doses: 6 })] },
  ]);
  const [results, setResults] = useState<ArmResult[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [name, setName] = useState('Vancomycin dosing comparison');
  const worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);
  const drug = getDrug(drugId);

  const run = () => {
    worker.current?.terminate();
    const w = new Worker(new URL('../workers/trial.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    setProgress(0);
    setResults(null);
    w.onmessage = (e) => {
      if (e.data.type === 'progress') setProgress(e.data.value);
      else if (e.data.type === 'done') {
        setResults(e.data.results);
        setProgress(null);
        w.terminate();
      } else if (e.data.type === 'error') {
        toast(e.data.message, 'error');
        setProgress(null);
      }
    };
    const payload: TrialArm[] = arms.map((a) => ({ id: a.id, label: a.label, regimens: a.regimens }));
    w.postMessage({ spec, arms: payload, drugId });
  };
  const cancel = () => {
    worker.current?.terminate();
    setProgress(null);
  };
  const set = <K extends keyof PopulationSpec>(k: K, v: PopulationSpec[K]) => setSpec({ ...spec, [k]: v });
  const unitLabel = drug.therapeutic?.basis === 'auc24' ? 'mg·h/L' : drug.display.unit;

  const subgroups = useMemo(() => {
    if (!results) return null;
    const groups: { label: string; test: (s: ArmResult['subjects'][number]) => boolean }[] = [
      { label: 'CrCl < 30', test: (s) => s.crcl < 30 },
      { label: 'CrCl 30–59', test: (s) => s.crcl >= 30 && s.crcl < 60 },
      { label: 'CrCl 60–89', test: (s) => s.crcl >= 60 && s.crcl < 90 },
      { label: 'CrCl ≥ 90', test: (s) => s.crcl >= 90 },
      { label: 'Age ≥ 75', test: (s) => s.age >= 75 },
      { label: 'Female', test: (s) => s.sex === 'female' },
    ];
    for (const g of ['CYP2D6', 'CYP2C19', 'CYP2C9', 'CYP3A5']) {
      if (drug.metabolism.some((m) => m.pathway === g) || drug.prodrug?.pathway === g)
        for (const p of ['PM', 'IM', 'UM']) groups.push({ label: `${g} ${p}`, test: (s) => s.phenotype.includes(`${g}:${p}`) });
    }
    return groups.map((g) => ({
      label: g.label,
      arms: results.map((r) => {
        const sub = r.subjects.filter(g.test);
        return { n: sub.length, pta: sub.length ? sub.filter((s) => s.status === 'within').length / sub.length : null, tox: sub.length ? sub.filter((s) => s.status === 'toxic').length / sub.length : null };
      }),
    })).filter((g) => g.arms.some((a) => a.n > 0));
  }, [results, drug]);

  return (
    <div>
      <PageHeader
        icon={<FlaskConical className="size-5" />}
        title="Virtual clinical trials"
        description="Simulate a virtual population with realistic covariates, inter-individual variability (log-normal) and ancestry-specific genotype frequencies. Compare dosing arms by probability of target attainment and toxicity."
        actions={progress !== null ? <Button variant="secondary" icon={<Square className="size-4" />} onClick={cancel}>Cancel</Button> : <Button icon={<Play className="size-4" />} onClick={run}>Run trial</Button>}
      />
      <div className="grid gap-6 xl:grid-cols-[400px_1fr]">
        <div className="flex flex-col gap-4">
          <Card title="Virtual population">
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="Subjects per arm" value={spec.n} min={10} max={2000} step={10} onChange={(v) => set('n', Math.round(v))} hint="Larger = slower, more precise" />
              <NumberField label="Random seed" value={spec.seed} min={1} max={1e9} step={1} onChange={(v) => set('seed', Math.round(v))} info="Same seed reproduces the identical population." />
              <NumberField label="Mean age" value={spec.ageMean} min={1} max={100} unit="y" onChange={(v) => set('ageMean', v)} />
              <NumberField label="Age SD" value={spec.ageSd} min={0} max={40} unit="y" onChange={(v) => set('ageSd', v)} />
              <NumberField label="Mean weight" value={spec.weightMean} min={10} max={200} unit="kg" onChange={(v) => set('weightMean', v)} />
              <NumberField label="Female" value={spec.femalePct} min={0} max={100} unit="%" onChange={(v) => set('femalePct', v)} />
              <NumberField label="Median SCr" value={spec.scrMedian} min={0.3} max={8} step={0.05} unit="mg/dL" onChange={(v) => set('scrMedian', v)} />
              <NumberField label="Hepatic impairment" value={spec.hepaticImpairedPct} min={0} max={100} unit="%" onChange={(v) => set('hepaticImpairedPct', v)} />
              <NumberField label="Smokers" value={spec.smokerPct} min={0} max={100} unit="%" onChange={(v) => set('smokerPct', v)} />
              <Field label="Ancestry (genotype frequencies)" htmlFor="anc">
                <Select id="anc" value={spec.ancestry} onChange={(e) => set('ancestry', e.target.value as Ancestry)}>
                  {(Object.keys(PHENOTYPE_FREQ) as Ancestry[]).map((a) => <option key={a}>{a}</option>)}
                </Select>
              </Field>
            </div>
          </Card>
          <Card title="Study drug & arms">
            <Field label="Primary medicine (endpoint)" htmlFor="pd">
              <DrugSelect id="pd" value={drugId} onChange={(id) => { setDrugId(id); setArms([{ id: 'a', label: 'Standard dose', regimens: [makeRegimen(id)] }]); setResults(null); setName(`${getDrug(id).name} trial`); }} />
            </Field>
            <div className="mt-4 flex flex-col gap-4">
              {arms.map((a, i) => (
                <div key={a.id} className="rounded-xl border border-line p-3" style={{ borderLeft: `4px solid ${ARM_COLORS[i]}` }}>
                  <div className="mb-2 flex items-center gap-2">
                    <Input aria-label={`Arm ${i + 1} label`} value={a.label} maxLength={60} onChange={(e) => setArms(arms.map((x) => (x.id === a.id ? { ...x, label: e.target.value } : x)))} />
                    {arms.length > 1 && <button className="rounded-md p-2 text-muted hover:bg-danger-soft hover:text-danger" aria-label={`Remove arm ${a.label}`} onClick={() => setArms(arms.filter((x) => x.id !== a.id))}><Trash2 className="size-4" /></button>}
                  </div>
                  <RegimenEditor regimens={a.regimens} onChange={(r) => setArms(arms.map((x) => (x.id === a.id ? { ...x, regimens: r.length ? r : x.regimens } : x)))} colors={() => ARM_COLORS[i]} max={3} />
                </div>
              ))}
              {arms.length < 3 && <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setArms([...arms, { id: uid('arm'), label: `Arm ${arms.length + 1}`, regimens: [makeRegimen(drugId)] }])}>Add arm</Button>}
            </div>
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {progress !== null && (
            <Card>
              <p className="text-sm font-medium" id="prog-label">Simulating {spec.n * arms.length} virtual patients…</p>
              <div className="mt-2 h-2 overflow-hidden rounded bg-surface-3" role="progressbar" aria-labelledby="prog-label" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-primary transition-[width]" style={{ width: `${progress * 100}%` }} />
              </div>
            </Card>
          )}
          {!results && progress === null && (
            <Callout tone="info" title="Design your trial, then run it">
              Each arm is simulated on the same virtual population (paired design), so differences reflect the regimen, not sampling noise. Primary endpoint: {drug.therapeutic ? `${drug.therapeutic.basis} within ${drug.therapeutic.low}–${drug.therapeutic.high} ${unitLabel}` : 'average concentration (no therapeutic target defined)'}.
            </Callout>
          )}
          {results && (
            <>
              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${results.length}, minmax(0, 1fr))` }}>
                {results.map((r, i) => (
                  <div key={r.armId} className="rounded-2xl border border-line bg-surface p-4" style={{ borderTop: `4px solid ${ARM_COLORS[i]}` }}>
                    <p className="truncate text-sm font-semibold">{r.label}</p>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Stat label="Target attainment" value={r.pta !== null ? `${(r.pta * 100).toFixed(0)}%` : '—'} tone={r.pta !== null ? (r.pta >= 0.7 ? 'ok' : 'warn') : undefined} />
                      <Stat label="Toxic exposure" value={r.pToxic !== null ? `${(r.pToxic * 100).toFixed(0)}%` : '—'} tone={r.pToxic !== null && r.pToxic > 0.1 ? 'danger' : undefined} />
                      <Stat label="Median AUC₂₄" value={fmt(r.summary.auc24Median)} sub={`CV ${(r.summary.cvAuc * 100).toFixed(0)}%`} />
                      <Stat label="Below target" value={r.pBelow !== null ? `${(r.pBelow * 100).toFixed(0)}%` : '—'} />
                    </div>
                  </div>
                ))}
              </div>
              <Card title="Concentration–time percentiles" subtitle="Shaded: 5th–95th and 25th–75th percentiles; line: median.">
                <div className="grid gap-5 2xl:grid-cols-2">
                  {results.map((r, i) => (
                    <div key={r.armId}>
                      <p className="mb-1 text-sm font-medium">{r.label}</p>
                      <BandChart label={`${r.label} percentile bands`} t={r.t} {...r.percentiles} unit={drug.display.unit} color={ARM_COLORS[i]} band={drug.therapeutic && drug.therapeutic.basis !== 'auc24' ? drug.therapeutic : undefined} toxic={drug.toxic && drug.toxic.basis !== 'auc24' ? drug.toxic.value : undefined} height={240} />
                    </div>
                  ))}
                </div>
              </Card>
              <Card title={`Distribution of ${results[0].metric.name}`} subtitle={unitLabel}>
                <div className="grid gap-6 lg:grid-cols-2">
                  {results.map((r, i) => (
                    <div key={r.armId}>
                      <p className="mb-2 text-sm font-medium">{r.label}</p>
                      <Histogram label={r.label} values={r.metric.values} unit={unitLabel} low={drug.therapeutic?.low} high={drug.therapeutic?.high} toxic={drug.toxic && drug.toxic.basis === drug.therapeutic?.basis ? drug.toxic.value : undefined} color={ARM_COLORS[i]} />
                    </div>
                  ))}
                </div>
              </Card>
              {subgroups && (
                <Card title="Subgroup analysis" subtitle="Target attainment / toxic exposure by covariate">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] text-sm">
                      <thead><tr className="text-left text-xs text-muted"><th className="pb-2 font-medium">Subgroup</th>{results.map((r) => <th key={r.armId} className="pb-2 font-medium">{r.label}</th>)}</tr></thead>
                      <tbody>
                        {subgroups.map((g) => (
                          <tr key={g.label} className="border-t border-line">
                            <td className="py-1.5 font-medium">{g.label} <span className="text-xs text-muted">(n={g.arms[0].n})</span></td>
                            {g.arms.map((a, i) => (
                              <td key={i} className="py-1.5 tabular">
                                {a.pta === null ? '—' : <span className={cx(a.pta < 0.5 && 'text-warn')}>{(a.pta * 100).toFixed(0)}%</span>}
                                {a.tox !== null && a.tox > 0 && <Badge tone="danger" className="ml-2">{(a.tox * 100).toFixed(0)}% toxic</Badge>}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Input aria-label="Trial name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className="max-w-xs" />
                <Button variant="secondary" onClick={() => post('/simulations', { name, kind: 'trial', config: { spec, drugId, arms }, summary: { arms: results.map((r) => ({ label: r.label, pta: r.pta, pToxic: r.pToxic, auc24Median: r.summary.auc24Median })) } }).then(() => toast('Trial saved')).catch((e) => toast(e.message, 'error'))}>Save trial</Button>
                <Button variant="secondary" icon={<Download className="size-4" />} onClick={() => downloadCsv('virtual-trial-subjects.csv', [['arm', 'age', 'sex', 'weight_kg', 'crcl', 'phenotypes', results[0].metric.name, 'status'], ...results.flatMap((r) => r.subjects.map((s) => [r.label, s.age, s.sex, s.weight, s.crcl, s.phenotype, s.metric.toPrecision(4), s.status]))])}>Export subjects</Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
