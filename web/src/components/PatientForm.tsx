import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  derivePhysiology, getDrug, PHENOTYPE_LABEL, PROCEDURES, PROCEDURE_MAP,
  type MedicationCourse, type Patient, type Phenotype, type ProcedureRecord,
} from '@medcare/engine';
import { Badge, Button, Card, Field, Input, NumberField, Select, Switch, cx } from './ui';
import { DrugSelect, ROUTE_LABEL } from './clinical';
import { fmt, uid } from '../lib/format';

const PHENOS: Phenotype[] = ['PM', 'IM', 'NM', 'RM', 'UM'];

export function PhysiologySummary({ patient }: { patient: Patient }) {
  const p = useMemo(() => derivePhysiology(patient), [patient]);
  const rows: [string, string, string?][] = [
    ['BMI', `${fmt(p.bmi)} kg/m²`, p.bmi >= 30 ? 'warn' : undefined],
    ['Body surface area', `${p.bsa.toFixed(2)} m²`],
    ['Ideal / adjusted body weight', `${fmt(p.ibw)} / ${fmt(p.abw)} kg`],
    ['Lean body weight', `${fmt(p.lbw)} kg`],
    ['Creatinine clearance (C–G)', `${fmt(p.crcl)} mL/min`, p.crcl < 30 ? 'danger' : p.crcl < 60 ? 'warn' : undefined],
    ['eGFR (CKD-EPI 2021)', `${fmt(p.egfr)} mL/min/1.73m² · ${p.ckdStage}`, p.egfr < 30 ? 'danger' : p.egfr < 60 ? 'warn' : undefined],
    ['Hepatic clearance factor', `${(p.hepaticFactor * 100).toFixed(0)}%`, p.hepaticFactor < 0.6 ? 'danger' : p.hepaticFactor < 0.85 ? 'warn' : undefined],
    ['Oral absorption factor', `${(p.absorptionFactor * 100).toFixed(0)}%`, p.absorptionFactor < 0.9 ? 'warn' : undefined],
    ['Baseline QTc', `${p.baselineQTc} ms`],
  ];
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-1 gap-x-4 text-sm sm:grid-cols-2">
        {rows.map(([k, v, tone]) => (
          <div key={k} className="flex justify-between gap-2 border-b border-line py-1.5">
            <dt className="text-muted">{k}</dt>
            <dd className={cx('text-right font-medium tabular', tone === 'warn' && 'text-warn', tone === 'danger' && 'text-danger')}>{v}</dd>
          </div>
        ))}
      </dl>
      <div>
        <p className="mb-1.5 text-xs font-medium text-fg-2">Pathway activity vs. reference</p>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(p.enzymeActivity).filter(([k]) => k !== 'CYP3A5').map(([k, v]) => (
            <Badge key={k} tone={v < 0.5 ? 'danger' : v < 0.9 ? 'warn' : v > 1.2 ? 'info' : 'neutral'}>
              {k} {(v * 100).toFixed(0)}%
            </Badge>
          ))}
          <Badge tone={p.enzymeActivity.CYP3A5 > 0 ? 'info' : 'neutral'}>CYP3A5 {p.enzymeActivity.CYP3A5 > 0 ? 'expresser' : 'non-expresser'}</Badge>
        </div>
      </div>
      {p.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-xs text-fg-2">
          {p.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}

export function PatientForm({ value, onChange }: { value: Patient; onChange: (p: Patient) => void }) {
  const set = <K extends keyof Patient>(k: K, v: Patient[K]) => onChange({ ...value, [k]: v });
  const [allergy, setAllergy] = useState('');
  const [condition, setCondition] = useState('');
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card title="Demographics & body size">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="col-span-2 sm:col-span-3">
            <Field label="Display name" htmlFor="pname">
              <Input id="pname" value={value.name} maxLength={80} onChange={(e) => set('name', e.target.value)} />
            </Field>
          </div>
          <NumberField label="Age" value={value.age} min={0.1} max={120} unit="years" onChange={(v) => set('age', v)} />
          <Field label="Sex at birth" htmlFor="sex" info="Used by physiological equations (CrCl, CKD-EPI, lean body weight).">
            <Select id="sex" value={value.sex} onChange={(e) => set('sex', e.target.value as Patient['sex'])}>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </Select>
          </Field>
          <NumberField label="Weight" value={value.weightKg} min={1} max={400} unit="kg" onChange={(v) => set('weightKg', v)} />
          <NumberField label="Height" value={value.heightCm} min={40} max={250} unit="cm" onChange={(v) => set('heightCm', v)} />
          <NumberField label="Baseline heart rate" value={value.baselineHR ?? 72} min={20} max={220} unit="bpm" onChange={(v) => set('baselineHR', v)} />
          <NumberField label="Baseline systolic BP" value={value.baselineSBP ?? 130} min={50} max={260} unit="mmHg" onChange={(v) => set('baselineSBP', v)} />
        </div>
      </Card>
      <Card title="Labs & organ function">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <NumberField label="Serum creatinine" value={value.scr} min={0.1} max={20} step={0.1} unit="mg/dL" onChange={(v) => set('scr', v)} hint="µmol/L ÷ 88.4" />
          <NumberField label="Albumin" value={value.albumin} min={1} max={6.5} step={0.1} unit="g/dL" onChange={(v) => set('albumin', v)} />
          <NumberField label="Potassium" value={value.potassium} min={1.5} max={9} step={0.1} unit="mmol/L" onChange={(v) => set('potassium', v)} />
          <NumberField label="Baseline QTc" value={value.baselineQTc ?? (value.sex === 'female' ? 420 : 410)} min={300} max={650} unit="ms" onChange={(v) => set('baselineQTc', v)} />
          <Field label="Liver function (Child–Pugh)" htmlFor="cp" info="Child–Pugh class scales hepatic clearance: A 80%, B 55%, C 35%.">
            <Select id="cp" value={value.childPugh} onChange={(e) => set('childPugh', e.target.value as Patient['childPugh'])}>
              <option value="none">Normal</option>
              <option value="A">Class A (mild)</option>
              <option value="B">Class B (moderate)</option>
              <option value="C">Class C (severe)</option>
            </Select>
          </Field>
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <Switch checked={value.heartFailure} onChange={(v) => set('heartFailure', v)} label="Heart failure" description="Reduces hepatic blood flow and clearance." />
          <Switch checked={value.pregnant} onChange={(v) => set('pregnant', v)} label="Pregnant (3rd trimester physiology)" description="Volume ↑, CYP3A4/2D6/UGT ↑, CYP1A2 ↓." />
        </div>
      </Card>
      <Card title="Pharmacogenomics" subtitle="Phenotypes inferred from genotype (CPIC terminology).">
        <div className="grid grid-cols-2 gap-3">
          {(['CYP2D6', 'CYP2C19', 'CYP2C9'] as const).map((g) => (
            <Field key={g} label={g} htmlFor={g}>
              <Select id={g} value={value.phenotypes[g]} onChange={(e) => set('phenotypes', { ...value.phenotypes, [g]: e.target.value as Phenotype })}>
                {PHENOS.filter((p) => g !== 'CYP2C9' || ['PM', 'IM', 'NM'].includes(p)).map((p) => (
                  <option key={p} value={p}>
                    {PHENOTYPE_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
          <Field label="CYP3A5" htmlFor="CYP3A5">
            <Select id="CYP3A5" value={value.phenotypes.CYP3A5} onChange={(e) => set('phenotypes', { ...value.phenotypes, CYP3A5: e.target.value as Phenotype })}>
              <option value="PM">Non-expresser (*3/*3)</option>
              <option value="IM">Intermediate (*1/*3)</option>
              <option value="NM">Expresser (*1/*1)</option>
            </Select>
          </Field>
          <Field label="VKORC1 −1639G>A" htmlFor="vk">
            <Select id="vk" value={value.vkorc1} onChange={(e) => set('vkorc1', e.target.value as Patient['vkorc1'])}>
              <option value="GG">GG (normal sensitivity)</option>
              <option value="AG">AG (increased)</option>
              <option value="AA">AA (high sensitivity)</option>
            </Select>
          </Field>
        </div>
        <fieldset className="mt-4">
          <legend className="mb-2 text-xs font-medium text-fg-2">HLA risk alleles</legend>
          <div className="flex flex-col gap-2">
            {(['B1502', 'B5701', 'B5801'] as const).map((h) => (
              <label key={h} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={value.hla[h]} onChange={(e) => set('hla', { ...value.hla, [h]: e.target.checked })} />
                HLA-{h.slice(0, 1)}*{h.slice(1, 3)}:{h.slice(3)} positive
                <span className="text-xs text-muted">{h === 'B1502' ? '(carbamazepine/phenytoin SJS)' : h === 'B5701' ? '(abacavir)' : '(allopurinol)'}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </Card>
      <Card title="Lifestyle, conditions & allergies">
        <div className="flex flex-col gap-3">
          <Switch checked={value.smoker} onChange={(v) => set('smoker', v)} label="Tobacco smoker" description="Induces CYP1A2." />
          <Field label="Alcohol use" htmlFor="alc">
            <Select id="alc" value={value.alcoholUse} onChange={(e) => set('alcoholUse', e.target.value as Patient['alcoholUse'])}>
              <option value="none">None</option>
              <option value="moderate">Moderate</option>
              <option value="heavy">Heavy (chronic)</option>
            </Select>
          </Field>
          <Field label="Conditions" htmlFor="cond">
            <div className="flex gap-2">
              <Input id="cond" value={condition} maxLength={120} placeholder="e.g. Type 2 diabetes" onChange={(e) => setCondition(e.target.value)} onKeyDown={(e) => {
                if (e.key === 'Enter' && condition.trim()) {
                  set('conditions', [...value.conditions, { id: uid('c'), name: condition.trim() }]);
                  setCondition('');
                }
              }} />
              <Button variant="secondary" disabled={!condition.trim()} onClick={() => { set('conditions', [...value.conditions, { id: uid('c'), name: condition.trim() }]); setCondition(''); }}>Add</Button>
            </div>
          </Field>
          <div className="flex flex-wrap gap-1.5">
            {value.conditions.map((c) => (
              <Badge key={c.id}>
                {c.name}
                <button aria-label={`Remove ${c.name}`} onClick={() => set('conditions', value.conditions.filter((x) => x.id !== c.id))} className="ml-0.5 text-muted hover:text-danger">×</button>
              </Badge>
            ))}
          </div>
          <Field label="Allergies" htmlFor="alg" hint="Matched against drug names, brands and classes.">
            <div className="flex gap-2">
              <Input id="alg" value={allergy} maxLength={60} placeholder="e.g. NSAID, codeine" onChange={(e) => setAllergy(e.target.value)} onKeyDown={(e) => {
                if (e.key === 'Enter' && allergy.trim()) {
                  set('allergies', [...value.allergies, allergy.trim()]);
                  setAllergy('');
                }
              }} />
              <Button variant="secondary" disabled={!allergy.trim()} onClick={() => { set('allergies', [...value.allergies, allergy.trim()]); setAllergy(''); }}>Add</Button>
            </div>
          </Field>
          <div className="flex flex-wrap gap-1.5">
            {value.allergies.map((a, i) => (
              <Badge key={a + i} tone="danger">
                {a}
                <button aria-label={`Remove allergy ${a}`} onClick={() => set('allergies', value.allergies.filter((_, j) => j !== i))} className="ml-0.5 hover:opacity-70">×</button>
              </Badge>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

export function HistoryEditor({ value, onChange }: { value: Patient; onChange: (p: Patient) => void }) {
  const [proc, setProc] = useState<ProcedureRecord>({ id: '', type: PROCEDURES[0].id, date: today() });
  const [course, setCourse] = useState<MedicationCourse>({
    id: '', drugId: 'amiodarone', dose: 200, unit: 'mg', intervalH: 24, route: 'po',
    start: new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10), end: today(),
  });
  const timeline = [
    ...value.procedures.map((p) => ({ kind: 'procedure' as const, date: p.date, id: p.id, label: PROCEDURE_MAP[p.type]?.name ?? p.type, sub: PROCEDURE_MAP[p.type]?.category })),
    ...value.medicationHistory.map((m) => ({
      kind: 'medication' as const, date: m.start, id: m.id, label: getDrug(m.drugId).name,
      sub: `${m.dose} ${m.unit} ${ROUTE_LABEL[m.route]} q${m.intervalH}h · until ${m.end.slice(0, 10)}`,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const courseInvalid = !course.start || !course.end || course.end < course.start;
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_1.1fr]">
      <div className="flex flex-col gap-5">
        <Card title="Add a past procedure or surgery" subtitle="Procedures change absorption, hepatic capacity or distribution and raise standing alerts.">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Field label="Procedure" htmlFor="ptype">
                <Select id="ptype" value={proc.type} onChange={(e) => setProc({ ...proc, type: e.target.value })}>
                  {Array.from(new Set(PROCEDURES.map((p) => p.category))).map((c) => (
                    <optgroup key={c} label={c}>
                      {PROCEDURES.filter((p) => p.category === c).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </optgroup>
                  ))}
                </Select>
              </Field>
              <p className="mt-1 text-xs text-muted">{PROCEDURE_MAP[proc.type]?.description}</p>
            </div>
            <Field label="Date" htmlFor="pdate">
              <Input id="pdate" type="date" value={proc.date} max={today()} onChange={(e) => setProc({ ...proc, date: e.target.value })} />
            </Field>
            <div className="flex items-end">
              <Button className="w-full" icon={<Plus className="size-4" />} disabled={!proc.date} onClick={() => onChange({ ...value, procedures: [...value.procedures, { ...proc, id: uid('p') }] })}>
                Add procedure
              </Button>
            </div>
          </div>
        </Card>
        <Card title="Add a past or current medication course" subtitle="Used to reconstruct exposure, residual levels, enzyme carry-over and cumulative dose.">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Field label="Medicine" htmlFor="cdrug">
                <DrugSelect id="cdrug" value={course.drugId} onChange={(id) => {
                  const d = getDrug(id).defaultRegimen;
                  setCourse({ ...course, drugId: id, dose: d.dose, unit: d.unit, intervalH: d.intervalH, route: d.route, infusionH: d.infusionH });
                }} />
              </Field>
            </div>
            <NumberField label="Dose" value={course.dose} min={0.001} max={100000} unit={course.unit} onChange={(v) => setCourse({ ...course, dose: v })} />
            <NumberField label="Interval" value={course.intervalH} min={0.25} max={1440} unit="h" onChange={(v) => setCourse({ ...course, intervalH: v })} />
            <Field label="Start" htmlFor="cstart">
              <Input id="cstart" type="date" value={course.start.slice(0, 10)} onChange={(e) => setCourse({ ...course, start: e.target.value })} />
            </Field>
            <Field label="End" htmlFor="cend" error={courseInvalid ? 'End must be after start' : undefined}>
              <Input id="cend" type="date" value={course.end.slice(0, 10)} aria-invalid={courseInvalid} onChange={(e) => setCourse({ ...course, end: e.target.value })} />
            </Field>
            <div className="col-span-2">
              <Button className="w-full" icon={<Plus className="size-4" />} disabled={courseInvalid} onClick={() => onChange({
                ...value,
                medicationHistory: [...value.medicationHistory, { ...course, id: uid('m'), start: new Date(course.start).toISOString(), end: new Date(course.end + 'T23:59:00').toISOString() }],
              })}>
                Add medication course
              </Button>
            </div>
          </div>
        </Card>
      </div>
      <Card title="Clinical timeline" subtitle={`${timeline.length} recorded events`}>
        {timeline.length === 0 ? (
          <p className="text-sm text-muted">No history yet. Add procedures and medication courses to see their lasting effects in the Retrospective tab.</p>
        ) : (
          <ol className="relative ml-2 border-l border-line">
            {timeline.map((e) => (
              <li key={e.id} className="mb-4 ml-4">
                <span className={cx('absolute -left-[5px] mt-1.5 size-2.5 rounded-full', e.kind === 'procedure' ? 'bg-[var(--s7)]' : 'bg-[var(--s1)]')} aria-hidden />
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs text-muted tabular">{e.date.slice(0, 10)} · {e.kind === 'procedure' ? 'Procedure' : 'Medication'}</p>
                    <p className="text-sm font-medium">{e.label}</p>
                    <p className="text-xs text-muted">{e.sub}</p>
                  </div>
                  <button
                    aria-label={`Remove ${e.label}`}
                    className="rounded-md p-1 text-muted hover:bg-danger-soft hover:text-danger"
                    onClick={() =>
                      onChange(
                        e.kind === 'procedure'
                          ? { ...value, procedures: value.procedures.filter((p) => p.id !== e.id) }
                          : { ...value, medicationHistory: value.medicationHistory.filter((m) => m.id !== e.id) },
                      )
                    }
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
