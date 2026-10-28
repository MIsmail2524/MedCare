import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Microscope } from 'lucide-react';
import {
  BUG_DRUGS, CHEMICALS, CHEMO, DRUGS, ENVIRONMENTS, METABOLIC_DRUGS, OCCUPANCY, SPECIES, defaultPatient, deprescribe, detectionWindow,
  environmentComparison, getDrug, glucoseDay, impliedDose, makeRegimen, occupancyForecast, oncologyTrial, organSupportScenarios, paediatricDoseCurve,
  resistanceEmergence, reverseDosimetry, sessionRemoval, simulateOncology, speciesTwin, substitutesFor, targetAttainment, type AgeSignal, type Shortage,
} from '@medcare/engine';
import { useSafetyKB } from '../lib/safety';
import { fmt, fmtHours } from '../lib/format';
import { Badge, Button, Callout, Card, Field, NumberField, PageHeader, Select, Stat, cx } from '../components/ui';
import { TimeChart } from '../components/charts';
import { SearchInput } from '../components/clinical';

interface FieldsKB {
  ageSignals: AgeSignal[];
  ageModel: { n: number; spearmanElderly: number; spearmanPaediatric: number } | null;
  shortages: Shortage[];
  vet: Record<string, { ingredients: [string, number][]; reactions: [string, number][] }>;
  builtAt: string;
}

let fieldsPromise: Promise<FieldsKB> | null = null;
function useFieldsKB() {
  const [kb, setKb] = useState<FieldsKB | null>(null);
  useEffect(() => {
    fieldsPromise ??= fetch('/data/fields-kb.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error('fields data missing'))));
    fieldsPromise.then(setKb).catch(() => setKb(null));
  }, []);
  return kb;
}

const TABS = [
  ['paeds', 'Paediatrics'], ['amr', 'Antimicrobial resistance'], ['onc', 'Oncology'], ['geri', 'Older adults'], ['icu', 'Dialysis & ICU'], ['mind', 'Mental health'],
  ['dm', 'Diabetes'], ['vet', 'Veterinary'], ['env', 'Environmental exposure'], ['xtr', 'Extreme environments'], ['dope', 'Anti-doping'], ['supply', 'Drug shortages'],
] as const;
type Tab = (typeof TABS)[number][0];

function Pane({ title, intro, controls, children }: { title: string; intro: string; controls: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-6 xl:grid-cols-[340px_1fr]">
      <Card title={title} subtitle={intro}><div className="flex flex-col gap-3">{controls}</div></Card>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </div>
  );
}

function DrugPick({ value, onChange, ids, label = 'Medicine' }: { value: string; onChange: (v: string) => void; ids: string[]; label?: string }) {
  return (
    <Field label={label} htmlFor={`dp-${label}`}>
      <Select id={`dp-${label}`} value={value} onChange={(e) => onChange(e.target.value)}>
        {ids.map((id) => <option key={id} value={id}>{getDrug(id).name}</option>)}
      </Select>
    </Field>
  );
}

function Paeds({ fk }: { fk: FieldsKB | null }) {
  const [drug, setDrug] = useState('midazolam');
  const curve = useMemo(() => paediatricDoseCurve(drug), [drug]);
  const sig = fk?.ageSignals.find((s) => s.name === drug || getDrug(drug).name.toLowerCase().startsWith(s.name));
  const ids = DRUGS.filter((d) => d.defaultRegimen.route !== 'iv_infusion' || d.id === 'vancomycin' || d.id === 'gentamicin').map((d) => d.id);
  return (
    <Pane title="Paediatric twin" intro="Growth curves, renal maturation and enzyme ontogeny (CYP3A4, 2D6, 2C9, 2C19, 1A2, UGT) drive the simulator, giving the mg/kg dose that matches adult exposure at each age." controls={<>
      <DrugPick value={drug} onChange={setDrug} ids={ids} />
      {sig && <Callout tone={sig.paediatricRatio > 1.5 ? 'warn' : 'info'} title="FAERS age signal">Children account for {sig.paediatricRatio.toFixed(2)}× the average share of reports for this medicine ({sig.reports.toLocaleString()} reports with age).</Callout>}
    </>}>
      <Card title="Dose for adult-equivalent exposure" subtitle="Twin (ontogeny + allometry) vs naive mg/kg scaling of the adult dose">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Age</th><th className="font-medium">Weight</th><th className="font-medium">Linear mg/kg</th><th className="font-medium">Twin mg/kg</th><th className="font-medium">Exposure at linear dose</th><th className="font-medium">CYP3A4 / UGT maturity</th></tr></thead>
          <tbody>
            {curve.map((c) => (
              <tr key={c.age} className="border-t border-line tabular">
                <td className="py-1.5">{c.age < 1 ? `${Math.round(c.age * 12)} mo` : `${c.age} y`}</td>
                <td>{fmt(c.weightKg)} kg</td>
                <td>{fmt(c.mgPerKgLinear)}</td>
                <td className="font-semibold">{fmt(c.mgPerKgTwin)}</td>
                <td className={cx(c.aucRatioAtLinear > 1.25 ? 'text-danger font-semibold' : c.aucRatioAtLinear < 0.8 ? 'text-warn font-semibold' : '')}>{(c.aucRatioAtLinear * 100).toFixed(0)}% of adult</td>
                <td>{Math.round(c.ontogeny.CYP3A4 * 100)}% / {Math.round(c.ontogeny.UGT * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Pane>
  );
}

function AMR() {
  const [bdId, setBd] = useState(BUG_DRUGS[0].id);
  const bd = BUG_DRUGS.find((b) => b.id === bdId)!;
  const base = makeRegimen(bd.drugId);
  const [dose, setDose] = useState(base.dose);
  const [interval, setInterval] = useState(base.intervalH);
  const [mic, setMic] = useState(bd.mic[Math.floor(bd.mic.length / 2)][0]);
  useEffect(() => {
    const b = makeRegimen(bd.drugId);
    setDose(b.dose);
    setInterval(b.intervalH);
    setMic(bd.mic[Math.floor(bd.mic.length / 2)][0]);
  }, [bd]);
  const reg = { ...base, dose, intervalH: interval, doses: Math.max(1, Math.round(168 / interval)) };
  const pta = useMemo(() => targetAttainment(bd, reg, 80), [bd, dose, interval]); // eslint-disable-line react-hooks/exhaustive-deps
  const res = useMemo(() => resistanceEmergence(defaultPatient(), reg, mic), [bd, dose, interval, mic]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Pane title="Resistance-aware dosing" intro="Population target attainment over the organism's MIC distribution, plus within-patient emergence of a resistant subpopulation (mutant selection window)." controls={<>
      <Field label="Pathogen / drug" htmlFor="bd"><Select id="bd" value={bdId} onChange={(e) => setBd(e.target.value)}>{BUG_DRUGS.map((b) => <option key={b.id} value={b.id}>{b.organism} — {getDrug(b.drugId).name}</option>)}</Select></Field>
      <div className="grid grid-cols-2 gap-3">
        <NumberField label="Dose" value={dose} min={1} max={10000} unit={base.unit} onChange={setDose} />
        <NumberField label="Interval" value={interval} min={4} max={48} unit="h" onChange={setInterval} />
      </div>
      <Field label="Isolate MIC" htmlFor="mic"><Select id="mic" value={mic} onChange={(e) => setMic(Number(e.target.value))}>{bd.mic.map(([m]) => <option key={m} value={m}>{m} mg/L{m > bd.breakpoint ? ' (resistant)' : ''}</option>)}</Select></Field>
      <p className="text-xs text-muted">Target {bd.index} ≥ {bd.target}. {bd.source}</p>
    </>}>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Cumulative fraction of response" value={`${Math.round(pta.cfr * 100)}%`} tone={pta.cfr >= 0.9 ? 'ok' : 'warn'} />
        <Stat label="Time in mutant selection window" value={`${Math.round(res.mswFraction * 100)}%`} tone={res.mswFraction > 0.5 ? 'danger' : undefined} />
        <Stat label="Resistance emergence" value={res.cleared ? 'cleared' : res.pResistanceEmergence > 0.5 ? 'likely' : 'unlikely'} tone={res.cleared ? 'ok' : res.pResistanceEmergence > 0.5 ? 'danger' : 'warn'} />
      </div>
      <Card title="Probability of target attainment by MIC">
        <div className="flex h-32 items-end gap-2">
          {pta.byMic.map((x) => (
            <div key={x.mic} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-[11px] tabular">{Math.round(x.pta * 100)}%</span>
              <div className={cx('w-full rounded-t-[4px]', x.mic > bd.breakpoint ? 'bg-[var(--s8)]' : 'bg-[var(--s1)]')} style={{ height: `${x.pta * 100}px` }} />
              <span className="text-[11px] text-muted">{x.mic}</span>
            </div>
          ))}
        </div>
        <p className="mt-1 text-center text-[11px] text-muted">MIC (mg/L); red = above breakpoint</p>
      </Card>
      <Card title="Bacterial populations during therapy (log₁₀ CFU)">
        <TimeChart ariaLabel="Bacterial populations" t={res.t} unit="log CFU" height={220} yDomain={[0, 11]} series={[{ def: { key: 's', label: 'Susceptible', color: 'var(--s1)' }, values: res.susceptible }, { def: { key: 'r', label: 'Resistant mutants', color: 'var(--s8)' }, values: res.resistant }]} />
      </Card>
    </Pane>
  );
}

function Onc() {
  const [id, setId] = useState(CHEMO[0].id);
  const agent = CHEMO.find((a) => a.id === id)!;
  const [dose, setDose] = useState(agent.standard.dose);
  const [interval, setInterval] = useState(agent.standard.intervalH / 24);
  useEffect(() => {
    setDose(agent.standard.dose);
    setInterval(agent.standard.intervalH / 24);
  }, [agent]);
  const sched = { ...agent.standard, dose, intervalH: interval * 24, cycles: Math.max(1, Math.round((agent.standard.cycles * agent.standard.intervalH) / (interval * 24))) };
  const trial = useMemo(() => oncologyTrial(agent, sched, 100), [agent, dose, interval]); // eslint-disable-line react-hooks/exhaustive-deps
  const one = useMemo(() => simulateOncology(agent, sched), [agent, dose, interval]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Pane title="Chemotherapy schedule twin" intro="Friberg semi-mechanistic neutropenia + Simeoni tumour growth/kill over a virtual population: compare dose-dense vs standard schedules for efficacy and grade-4 neutropenia." controls={<>
      <Field label="Agent" htmlFor="ag"><Select id="ag" value={id} onChange={(e) => setId(e.target.value)}>{CHEMO.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      <div className="grid grid-cols-2 gap-3">
        <NumberField label="Dose" value={dose} min={5} max={400} unit="mg/m²" onChange={setDose} />
        <NumberField label="Cycle length" value={interval} min={7} max={42} unit="days" onChange={setInterval} />
      </div>
      <p className="text-xs text-muted">{sched.cycles} cycles (same total treatment duration). {agent.source}</p>
    </>}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Grade 4 neutropenia" value={`${Math.round(trial.pGrade4 * 100)}%`} tone={trial.pGrade4 > 0.4 ? 'danger' : undefined} />
        <Stat label="Grade ≥ 3" value={`${Math.round(trial.pGrade3plus * 100)}%`} />
        <Stat label="Nadir (median)" value={fmt(trial.medianNadir)} unit="×10⁹/L" sub={`day ${fmt(trial.medianNadirDay)} of cycle`} />
        <Stat label="Tumour response (≥ 30 %)" value={`${Math.round(trial.pResponse * 100)}%`} tone={trial.pResponse > 0.3 ? 'ok' : 'warn'} />
      </div>
      <div className="grid gap-4 2xl:grid-cols-2">
        <Card title="Absolute neutrophil count (typical patient)"><TimeChart ariaLabel="ANC" t={one.t.map((d) => d * 24)} unit="×10⁹/L" height={200} refLines={[{ y: 0.5, label: 'grade 4' }, { y: 1, label: 'grade 3' }]} series={[{ def: { key: 'a', label: 'ANC', color: 'var(--s1)' }, values: one.anc }]} /></Card>
        <Card title="Relative tumour volume (typical patient)"><TimeChart ariaLabel="Tumour" t={one.t.map((d) => d * 24)} unit="× baseline" height={200} refLines={[{ y: 0.7, label: 'response' }]} series={[{ def: { key: 't', label: 'Tumour', color: 'var(--s2)' }, values: one.tumour }]} /></Card>
      </div>
    </Pane>
  );
}

function Geri({ fk }: { fk: FieldsKB | null }) {
  const [meds, setMeds] = useState<string[]>(['midazolam', 'morphine', 'haloperidol', 'amlodipine', 'atorvastatin', 'furosemide', 'citalopram']);
  const [keep, setKeep] = useState<string[]>(['atorvastatin', 'furosemide']);
  const [add, setAdd] = useState('');
  const patient = defaultPatient({ age: 84, sex: 'female', weightKg: 58, heightCm: 158, scr: 1.3 });
  const sig = useMemo(() => new Map((fk?.ageSignals ?? []).map((s) => [s.name, s])), [fk]);
  const res = useMemo(() => deprescribe(patient, meds, keep, sig), [meds, keep, sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Pane title="Deprescribing optimiser" intro="Greedy removal of the medicine that most reduces the combined anticholinergic, sedative, fall-risk, interaction, organ-function and FAERS elderly-signal burden, keeping essential drugs." controls={<>
      <ul className="flex flex-col gap-1.5">
        {meds.map((m) => (
          <li key={m} className="flex items-center justify-between gap-2 text-sm">
            <span>{getDrug(m).name}</span>
            <span className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={keep.includes(m)} onChange={(e) => setKeep(e.target.checked ? [...keep, m] : keep.filter((x) => x !== m))} />essential</label>
              <button className="text-muted hover:text-danger" aria-label={`Remove ${m}`} onClick={() => setMeds(meds.filter((x) => x !== m))}>×</button>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Select aria-label="Add medicine" value={add} onChange={(e) => setAdd(e.target.value)}><option value="">Add…</option>{DRUGS.filter((d) => !meds.includes(d.id)).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        <Button variant="secondary" disabled={!add} onClick={() => { setMeds([...meds, add]); setAdd(''); }}>Add</Button>
      </div>
      {fk?.ageModel && <p className="text-xs text-muted">Elderly-signal model (FAERS age data, {fk.ageModel.n} drugs): leave-one-out Spearman ρ = {fk.ageModel.spearmanElderly.toFixed(2)}.</p>}
    </>}>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Burden before" value={fmt(res.baseline.total)} />
        <Stat label="Burden after" value={fmt(res.finalBurden.total)} tone="ok" />
        <Stat label="Medicines removed" value={res.steps.length} />
      </div>
      <Card title="Proposed deprescribing sequence">
        {res.steps.length === 0 ? <p className="text-sm text-muted">No removal reduces burden meaningfully.</p> : (
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">{res.steps.map((s) => <li key={s.remove}><strong>{getDrug(s.remove).name}</strong> — {s.reason}; burden {fmt(s.before)} → {fmt(s.after)}{sig.get(s.remove) ? ` · FAERS elderly ratio ${sig.get(s.remove)!.elderlyRatio.toFixed(2)}` : ''}</li>)}</ol>
        )}
        <p className="mt-3 text-xs text-muted">Burden components after: anticholinergic {res.finalBurden.anticholinergic}, sedative {res.finalBurden.sedative}, fall-risk {res.finalBurden.fallRisk}, interactions {fmt(res.finalBurden.interactions)}, organ function {fmt(res.finalBurden.renalHepatic)}.</p>
      </Card>
    </Pane>
  );
}

function ICU() {
  const [drug, setDrug] = useState('vancomycin');
  const r = useMemo(() => organSupportScenarios(drug), [drug]);
  const ids = ['vancomycin', 'gentamicin', 'fluconazole', 'lithium', 'metformin', 'enoxaparin', 'digoxin', 'ciprofloxacin'];
  return (
    <Pane title="Patient + machine twin" intro="Exposure with no kidney function, intermittent haemodialysis, CRRT (CVVHDF) and septic shock with augmented renal clearance and capillary leak." controls={<>
      <DrugPick value={drug} onChange={setDrug} ids={ids} />
      <p className="text-sm">One 4-h dialysis session removes <strong>{Math.round(sessionRemoval(drug) * 100)}%</strong> of the body load.</p>
    </>}>
      <Card title="Exposure by scenario">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Scenario</th><th className="font-medium">AUC₂₄</th><th className="font-medium">vs normal</th><th className="font-medium">Status</th></tr></thead>
          <tbody>{r.scenarios.map((s) => <tr key={s.label} className="border-t border-line tabular"><td className="py-1.5">{s.label}</td><td>{fmt(s.auc24)}</td><td>{(s.auc24 / r.scenarios[0].auc24).toFixed(2)}×</td><td><Badge tone={s.targetStatus === 'within' ? 'ok' : 'warn'}>{s.targetStatus}</Badge></td></tr>)}</tbody>
        </table>
      </Card>
      <Card title="Concentration profiles"><TimeChart ariaLabel="Organ support concentration" t={r.scenarios[0].t} unit={getDrug(drug).display.unit} height={240} series={r.scenarios.map((s, i) => ({ def: { key: `s${i}`, label: s.label.split(':')[0].split('(')[0].trim(), color: `var(--s${i + 1})` }, values: s.conc }))} /></Card>
    </Pane>
  );
}

function Mind() {
  const [drug, setDrug] = useState('haloperidol');
  const [dose, setDose] = useState(2);
  useEffect(() => setDose(drug === 'haloperidol' ? 2 : getDrug(drug).defaultRegimen.dose), [drug]);
  const r = useMemo(() => occupancyForecast(defaultPatient(), makeRegimen(drug, { dose, doses: Math.round(24 * 14 / getDrug(drug).defaultRegimen.intervalH) })), [drug, dose]);
  return (
    <Pane title="Brain target-occupancy twin" intro="Plasma exposure → PET-calibrated receptor/transporter occupancy; time inside the window linked to response without adverse effects." controls={<>
      <DrugPick value={drug} onChange={setDrug} ids={OCCUPANCY.map((o) => o.drugId)} />
      <NumberField label="Dose" value={dose} min={0.25} max={500} unit="mg" onChange={setDose} hint={`every ${getDrug(drug).defaultRegimen.intervalH} h`} />
      <p className="text-xs text-muted">{r.model.target}: window {Math.round(r.model.window[0] * 100)}–{Math.round(r.model.window[1] * 100)}%. {r.model.source}</p>
    </>}>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Trough occupancy" value={`${Math.round(r.troughOccupancy * 100)}%`} />
        <Stat label="Time in window" value={`${Math.round(r.timeInWindow * 100)}%`} tone={r.timeInWindow > 0.6 ? 'ok' : 'warn'} />
        <Stat label="Time above adverse threshold" value={`${Math.round(r.timeAbove * 100)}%`} tone={r.timeAbove > 0.3 ? 'danger' : undefined} sub={r.model.adverseAbove?.effect} />
      </div>
      <Card title="Occupancy over time"><TimeChart ariaLabel="Occupancy" t={r.t} unit="occupancy" height={240} yDomain={[0, 1]} band={{ low: r.model.window[0], high: r.model.window[1], label: 'window' }} series={[{ def: { key: 'o', label: 'Occupancy', color: 'var(--s7)' }, values: r.occupancy }]} /></Card>
    </Pane>
  );
}

function DM() {
  const [type, setType] = useState<'t2d' | 'prediabetes' | 'healthy'>('t2d');
  const [on, setOn] = useState<string[]>(['metformin']);
  const r = useMemo(() => glucoseDay({ type, weightKg: 85 }, METABOLIC_DRUGS.filter((d) => on.includes(d.id))), [type, on]);
  return (
    <Pane title="Metabolic twin" intro="Bergman minimal model with meals; medicines alter hepatic glucose output, insulin secretion and sensitivity — including drug-induced hyperglycaemia from glucocorticoids." controls={<>
      <Field label="Metabolic state" htmlFor="mt"><Select id="mt" value={type} onChange={(e) => setType(e.target.value as typeof type)}><option value="healthy">Healthy</option><option value="prediabetes">Prediabetes</option><option value="t2d">Type 2 diabetes</option></Select></Field>
      {METABOLIC_DRUGS.map((d) => <label key={d.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={on.includes(d.id)} onChange={(e) => setOn(e.target.checked ? [...on, d.id] : on.filter((x) => x !== d.id))} />{d.name}</label>)}
    </>}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Mean glucose" value={fmt(r.meanGlucose)} unit="mg/dL" />
        <Stat label="Estimated HbA1c" value={r.hba1c.toFixed(1)} unit="%" tone={r.hba1c < 7 ? 'ok' : 'warn'} />
        <Stat label="Time in range 70–180" value={`${Math.round(r.timeInRange * 100)}%`} />
        <Stat label="Time < 70 mg/dL" value={`${Math.round(r.timeBelow70 * 100)}%`} tone={r.timeBelow70 > 0.04 ? 'danger' : undefined} />
      </div>
      <Card title="24-hour glucose"><TimeChart ariaLabel="Glucose" t={r.t} unit="mg/dL" height={240} yDomain={[40, 'auto']} band={{ low: 70, high: 180, label: 'target' }} series={[{ def: { key: 'g', label: 'Glucose', color: 'var(--s2)' }, values: r.glucose }]} /></Card>
    </Pane>
  );
}

function Vet({ fk }: { fk: FieldsKB | null }) {
  const [drug, setDrug] = useState('acetaminophen');
  const rows = useMemo(() => SPECIES.map((s) => speciesTwin(drug, s)), [drug]);
  const [sp, setSp] = useState('Dog');
  const v = fk?.vet?.[sp];
  return (
    <Pane title="Veterinary twin" intro="Allometric scaling with species-specific metabolic gaps (e.g. feline glucuronidation deficiency) and food-animal withdrawal times; FDA CVM adverse-event data by species." controls={<DrugPick value={drug} onChange={setDrug} ids={DRUGS.map((d) => d.id)} />}>
      <Card title="Species comparison">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Species</th><th className="font-medium">t½</th><th className="font-medium">Exposure at human mg/kg</th><th className="font-medium">mg/kg for human-equivalent AUC</th><th className="font-medium">Withdrawal</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.species.id} className="border-t border-line tabular"><td className="py-1.5">{r.species.name}</td><td>{fmtHours(r.halfLifeH)}</td><td>{(r.aucRatioAtHumanMgKg * 100).toFixed(0)}%</td><td>{fmt(r.doseMgKgForHumanAuc)}</td><td>{r.withdrawalDays === null ? '—' : `${r.withdrawalDays} d`}</td></tr>)}</tbody>
        </table>
        <ul className="mt-2 list-disc pl-4 text-xs text-fg-2">{SPECIES.map((s) => <li key={s.id}><strong>{s.name}:</strong> {s.note}</li>)}</ul>
      </Card>
      {v && (
        <Card title="FDA CVM adverse-event reports" actions={<Select aria-label="Species" className="h-8 w-32 text-xs" value={sp} onChange={(e) => setSp(e.target.value)}>{Object.keys(fk!.vet).map((k) => <option key={k}>{k}</option>)}</Select>}>
          <div className="grid gap-4 md:grid-cols-2 text-sm">
            <div><p className="mb-1 text-xs font-medium text-muted">Top active ingredients</p><ol className="list-decimal pl-5">{v.ingredients.slice(0, 10).map(([t, c]) => <li key={t}>{t.toLowerCase()} <span className="text-muted">({c.toLocaleString()})</span></li>)}</ol></div>
            <div><p className="mb-1 text-xs font-medium text-muted">Top reactions (VeDDRA)</p><ol className="list-decimal pl-5">{v.reactions.slice(0, 10).map(([t, c]) => <li key={t}>{t.toLowerCase()} <span className="text-muted">({c.toLocaleString()})</span></li>)}</ol></div>
          </div>
        </Card>
      )}
    </Pane>
  );
}

function Env() {
  const [id, setId] = useState(CHEMICALS[0].id);
  const c = CHEMICALS.find((x) => x.id === id)!;
  const [level, setLevel] = useState(c.typicalLevel);
  useEffect(() => setLevel(c.typicalLevel), [c]);
  const r = useMemo(() => reverseDosimetry(c, level), [c, level]);
  return (
    <Pane title="Exposure reconstruction" intro="Reverse dosimetry: from a biomonitoring level back to the daily intake that sustains it (Monte Carlo over half-life and volume), compared with regulatory reference doses." controls={<>
      <Field label="Chemical" htmlFor="ch"><Select id="ch" value={id} onChange={(e) => setId(e.target.value)}>{CHEMICALS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
      <NumberField label={`Measured ${c.matrix} level`} value={level} min={0.001} max={10000} unit={c.unit.split(' ')[0]} onChange={setLevel} />
      <p className="text-xs text-muted">{c.source}</p>
    </>}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Implied intake (median)" value={fmt(r.intakeMedian)} unit="ng/kg/day" />
        <Stat label="95th percentile" value={fmt(r.intakeP95)} unit="ng/kg/day" />
        <Stat label="Hazard quotient" value={r.hazardQuotient.toFixed(2)} tone={r.hazardQuotient > 1 ? 'danger' : 'ok'} sub={`vs ${c.referenceDose.value} ${c.referenceDose.unit}`} />
        <Stat label="Years to steady state" value={fmt(r.yearsToSteadyState)} />
      </div>
      <Callout tone={r.hazardQuotient > 1 ? 'warn' : 'info'}>Reference: {c.referenceDose.source}. A hazard quotient above 1 means the reconstructed intake exceeds the reference dose — a screening flag, not a diagnosis.</Callout>
    </Pane>
  );
}

function Extreme() {
  const [drug, setDrug] = useState('lithium');
  const rows = useMemo(() => environmentComparison(drug), [drug]);
  return (
    <Pane title="Extreme-environment twin" intro="Spaceflight, altitude hypoxia, heat/dehydration and hypothermia modify renal flow, hepatic enzyme activity, distribution and absorption." controls={<DrugPick value={drug} onChange={setDrug} ids={DRUGS.map((d) => d.id)} />}>
      <Card title="Exposure vs sea level">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Environment</th><th className="font-medium">AUC</th><th className="font-medium">Cmax</th><th className="font-medium">Status</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.env.id} className="border-t border-line tabular"><td className="py-1.5">{r.env.name}<p className="text-[11px] text-muted">{r.env.note}</p></td><td className={cx(r.aucRatio > 1.25 && 'font-semibold text-danger')}>{r.aucRatio.toFixed(2)}×</td><td>{r.cmaxRatio.toFixed(2)}×</td><td><Badge tone={r.status === 'toxic' ? 'danger' : r.status === 'within' ? 'ok' : 'warn'}>{r.status}</Badge></td></tr>)}</tbody>
        </table>
      </Card>
      <p className="text-xs text-muted">{ENVIRONMENTS.length} environments; modifiers summarise published physiological changes and are illustrative.</p>
    </Pane>
  );
}

function Dope() {
  const [drug, setDrug] = useState('furosemide');
  const [dose, setDose] = useState(40);
  const [lod, setLod] = useState(1);
  const [measured, setMeasured] = useState(20);
  const [claimH, setClaimH] = useState(36);
  const w = useMemo(() => detectionWindow(drug, dose, lod), [drug, dose, lod]);
  const implied = useMemo(() => impliedDose(drug, measured, claimH), [drug, measured, claimH]);
  return (
    <Pane title="Anti-doping twin" intro="Detection windows for a given intake and limit of detection, and the dose that a measured concentration implies at a claimed exposure time — testing the plausibility of 'contamination' explanations." controls={<>
      <DrugPick value={drug} onChange={setDrug} ids={['furosemide', 'metoprolol', 'morphine', 'methadone', 'codeine', 'fentanyl', 'midazolam']} />
      <div className="grid grid-cols-2 gap-3">
        <NumberField label="Single dose" value={dose} min={0.01} max={2000} unit="mg" onChange={setDose} />
        <NumberField label="Limit of detection" value={lod} min={0.001} max={1000} unit="ng/mL" onChange={setLod} />
        <NumberField label="Measured level" value={measured} min={0.001} max={10000} unit="ng/mL" onChange={setMeasured} />
        <NumberField label="Claimed hours since intake" value={claimH} min={0.5} max={500} unit="h" onChange={setClaimH} />
      </div>
    </>}>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Detectable for" value={w.lastDetectableH !== null ? fmtHours(w.lastDetectableH) : 'never above LOD'} />
        <Stat label="Implied dose at claimed time" value={fmt(implied)} unit="mg" sub={implied > getDrug(drug).defaultRegimen.dose * 3 ? 'far above a therapeutic or contaminant dose' : 'compatible with a therapeutic dose'} tone={implied > getDrug(drug).defaultRegimen.dose * 3 ? 'danger' : undefined} />
      </div>
      <Card title="Plasma concentration after a single dose"><TimeChart ariaLabel="Detection" t={w.t} unit="ng/mL" height={240} refLines={[{ y: lod, label: 'LOD' }]} series={[{ def: { key: 'c', label: getDrug(drug).name, color: 'var(--s1)' }, values: w.conc }]} /></Card>
    </Pane>
  );
}

function Supply({ fk }: { fk: FieldsKB | null }) {
  const { kb } = useSafetyKB();
  const [q, setQ] = useState('');
  const current = useMemo(() => (fk?.shortages ?? []).filter((s) => /current/i.test(s.status)), [fk]);
  const names = useMemo(() => Array.from(new Set(current.map((s) => s.generic.toLowerCase()))).filter((n) => n.includes(q.toLowerCase())).sort(), [current, q]);
  const [sel, setSel] = useState('');
  const subs = useMemo(() => (kb && sel ? substitutesFor(sel.split(/[ ,]/)[0], kb, fk?.shortages ?? []) : []), [kb, sel, fk]);
  return (
    <Pane title="Shortage-aware substitution" intro="Current FDA drug shortages, with therapeutic alternatives ranked by pharmacologic-class overlap and organ-safety profile, excluding drugs that are themselves short." controls={<>
      <p className="text-sm"><strong>{current.length}</strong> current shortage records ({names.length} medicines).</p>
      <SearchInput value={q} onChange={setQ} placeholder="Search shortages…" label="Search shortages" />
      <ul className="max-h-80 overflow-y-auto rounded-xl border border-line p-1">{names.slice(0, 200).map((n) => <li key={n}><button className={cx('w-full rounded-lg px-2 py-1 text-left text-sm capitalize', sel === n ? 'bg-primary-soft text-primary' : 'hover:bg-surface-2')} onClick={() => setSel(n)}>{n}</button></li>)}</ul>
    </>}>
      {!sel ? <Callout tone="info">Select a medicine in shortage to see alternatives.</Callout> : (
        <Card title={`Alternatives to ${sel}`} subtitle={current.filter((s) => s.generic.toLowerCase() === sel).map((s) => s.reason).filter(Boolean)[0] ?? 'Reason not stated'}>
          {subs.length === 0 ? <p className="text-sm text-muted">No class-matched alternative in the knowledge base.</p> : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Alternative</th><th className="font-medium">Class overlap</th><th className="font-medium">Label-warning burden vs original</th><th className="font-medium">Supply</th></tr></thead>
              <tbody>{subs.map((s) => <tr key={s.drug.name} className="border-t border-line"><td className="py-1.5">{s.drug.genericName}</td><td className="tabular">{Math.round(s.classOverlap * 100)}%</td><td className={cx('tabular', s.safetyDelta > 0 ? 'text-warn' : s.safetyDelta < 0 ? 'text-ok' : '')}>{s.safetyDelta > 0 ? '+' : ''}{s.safetyDelta}</td><td>{s.inShortage ? <Badge tone="danger">also short</Badge> : <Badge tone="ok">available</Badge>}</td></tr>)}</tbody>
            </table>
          )}
        </Card>
      )}
    </Pane>
  );
}

export default function TwinLab() {
  const fk = useFieldsKB();
  const [tab, setTab] = useState<Tab>('paeds');
  return (
    <div>
      <PageHeader icon={<Microscope className="size-5" />} title="Twin lab" description="The same mechanistic digital twin applied to twelve fields where exposure modelling is rarely connected to outcomes — from neonates and chemotherapy schedules to antimicrobial resistance, dialysis, space medicine and drug shortages." />
      <div className="mb-5 flex flex-wrap gap-1.5" role="tablist" aria-label="Fields">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cx('rounded-full border px-3 py-1 text-sm', tab === id ? 'border-primary bg-primary-soft font-medium text-primary' : 'border-line hover:border-line-strong')}>{label}</button>
        ))}
      </div>
      {tab === 'paeds' && <Paeds fk={fk} />}
      {tab === 'amr' && <AMR />}
      {tab === 'onc' && <Onc />}
      {tab === 'geri' && <Geri fk={fk} />}
      {tab === 'icu' && <ICU />}
      {tab === 'mind' && <Mind />}
      {tab === 'dm' && <DM />}
      {tab === 'vet' && <Vet fk={fk} />}
      {tab === 'env' && <Env />}
      {tab === 'xtr' && <Extreme />}
      {tab === 'dope' && <Dope />}
      {tab === 'supply' && <Supply fk={fk} />}
      <p className="mt-6 text-xs text-muted">Research and education prototypes. Models are simplified and partly calibrated to published summary data; sources are cited in each panel.</p>
    </div>
  );
}


