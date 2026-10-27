import { useEffect, useMemo, useState } from 'react';
import { Beaker, Save, CheckCircle2, XCircle, Trash2 } from 'lucide-react';
import { ascendingDoseStudy, assessDruglikeness, escalationDoses, EXAMPLE_COMPOUND, firstInHuman, KM_FACTORS, type CompoundInput, type Species } from '@medcare/engine';
import { del, get, post, put } from '../lib/api';
import { useToast } from '../lib/toast';
import { fmt, fmtHours } from '../lib/format';
import { Badge, Button, Card, Field, Input, NumberField, PageHeader, Select, Stat, Switch, Tabs, cx } from '../components/ui';
import { TimeChart } from '../components/charts';

interface Saved { id: string; name: string; data: CompoundInput }

export default function Discovery() {
  const toast = useToast();
  const [c, setC] = useState<CompoundInput>(EXAMPLE_COMPOUND);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [list, setList] = useState<Saved[]>([]);
  const [mad, setMad] = useState(false);
  const [tab, setTab] = useState<'props' | 'preclin'>('props');
  const set = <K extends keyof CompoundInput>(k: K, v: CompoundInput[K]) => setC({ ...c, [k]: v });
  const reload = () => get<{ compounds: Saved[] }>('/compounds').then((r) => setList(r.compounds)).catch(() => undefined);
  useEffect(() => {
    void reload();
  }, []);

  const fih = useMemo(() => firstInHuman(c), [c]);
  const like = useMemo(() => assessDruglikeness(c, fih.efficaciousDoseMg), [c, fih]);
  const doses = useMemo(() => escalationDoses(Math.max(0.1, Number(fih.mrsdMg.toPrecision(2))), 6), [fih]);
  const cohorts = useMemo(() => ascendingDoseStudy(c, fih, doses, mad), [c, fih, doses, mad]);
  const colors = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s7)'];

  const save = async () => {
    try {
      if (savedId) await put(`/compounds/${savedId}`, c);
      else setSavedId((await post<{ compound: { id: string } }>('/compounds', c)).compound.id);
      toast('Compound saved');
      void reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const rule = (ok: boolean, label: string) => (
    <li className="flex items-center gap-2 text-sm">
      {ok ? <CheckCircle2 className="size-4 text-ok" aria-hidden /> : <XCircle className="size-4 text-danger" aria-hidden />}
      <span className={cx(!ok && 'font-medium')}>{label}</span>
      <span className="sr-only">{ok ? 'pass' : 'fail'}</span>
    </li>
  );

  return (
    <div>
      <PageHeader
        icon={<Beaker className="size-5" />}
        title="Drug discovery sandbox"
        description="Characterise a novel compound, translate preclinical safety into a first-in-human starting dose (FDA 2005 guidance), scale PK allometrically and simulate single- and multiple-ascending-dose cohorts."
        actions={<Button icon={<Save className="size-4" />} onClick={save}>{savedId ? 'Update compound' : 'Save compound'}</Button>}
      />
      <div className="grid gap-6 xl:grid-cols-[400px_1fr]">
        <div className="flex flex-col gap-4">
          {list.length > 0 && (
            <Card title="My compounds">
              <ul className="space-y-1">
                {list.map((s) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <button className={cx('flex-1 truncate rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2', savedId === s.id && 'bg-primary-soft text-primary')} onClick={() => { setC(s.data); setSavedId(s.id); }}>{s.name}</button>
                    <button className="rounded-md p-1 text-muted hover:text-danger" aria-label={`Delete ${s.name}`} onClick={() => del(`/compounds/${s.id}`).then(() => { if (savedId === s.id) setSavedId(null); void reload(); })}><Trash2 className="size-4" /></button>
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => { setC({ ...EXAMPLE_COMPOUND, name: 'New compound' }); setSavedId(null); }}>+ New compound</Button>
            </Card>
          )}
          <Card bodyClass="p-4">
            <Tabs label="Compound inputs" value={tab} onChange={setTab} tabs={[{ id: 'props', label: 'Physicochemical' }, { id: 'preclin', label: 'Preclinical' }]} />
            <div className="mt-4">
              {tab === 'props' ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2"><Field label="Compound name" htmlFor="cn"><Input id="cn" value={c.name} maxLength={120} onChange={(e) => set('name', e.target.value)} /></Field></div>
                  <NumberField label="Molecular weight" value={c.mw} min={10} max={5000} unit="Da" onChange={(v) => set('mw', v)} />
                  <NumberField label="cLogP" value={c.logP} min={-10} max={15} step={0.1} onChange={(v) => set('logP', v)} />
                  <NumberField label="H-bond donors" value={c.hbd} min={0} max={50} step={1} onChange={(v) => set('hbd', Math.round(v))} />
                  <NumberField label="H-bond acceptors" value={c.hba} min={0} max={50} step={1} onChange={(v) => set('hba', Math.round(v))} />
                  <NumberField label="TPSA" value={c.tpsa} min={0} max={1000} unit="Å²" onChange={(v) => set('tpsa', v)} />
                  <NumberField label="Rotatable bonds" value={c.rotatableBonds} min={0} max={100} step={1} onChange={(v) => set('rotatableBonds', Math.round(v))} />
                  <NumberField label="Solubility" value={c.solubility} min={0.0001} max={1000} unit="mg/mL" onChange={(v) => set('solubility', v)} />
                  <NumberField label="Permeability" value={c.permeability} min={0} max={1000} unit="10⁻⁶ cm/s" onChange={(v) => set('permeability', v)} info="Caco-2 apparent permeability; ≥ 15 treated as high (metoprolol-like)." />
                  <NumberField label="Fraction unbound" value={c.fu} min={0.0001} max={1} step={0.01} onChange={(v) => set('fu', v)} />
                  <NumberField label="Predicted F (oral)" value={c.F} min={0.001} max={1} step={0.05} onChange={(v) => set('F', v)} />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Most sensitive species" htmlFor="sp">
                    <Select id="sp" value={c.species} onChange={(e) => set('species', e.target.value as Species)}>
                      {(Object.keys(KM_FACTORS).filter((k) => k !== 'human') as Species[]).map((s) => <option key={s} value={s}>{s} (Km {KM_FACTORS[s].km})</option>)}
                    </Select>
                  </Field>
                  <NumberField label="NOAEL" value={c.noaelMgKg} min={0.001} max={10000} unit="mg/kg" onChange={(v) => set('noaelMgKg', v)} />
                  <NumberField label="Animal CL" value={c.animalCL_mLminKg} min={0.01} max={1000} unit="mL/min/kg" onChange={(v) => set('animalCL_mLminKg', v)} />
                  <NumberField label="Animal Vss" value={c.animalVss_Lkg} min={0.01} max={500} unit="L/kg" onChange={(v) => set('animalVss_Lkg', v)} />
                  <NumberField label="Safety factor" value={c.safetyFactor} min={1} max={1000} onChange={(v) => set('safetyFactor', v)} info="FDA default 10; increase for steep dose–response, novel targets or irreversible toxicity." />
                  <NumberField label="Absorption ka" value={c.ka} min={0.01} max={50} unit="1/h" onChange={(v) => set('ka', v)} />
                  <div className="col-span-2"><NumberField label="Target efficacious concentration" value={c.targetConc} min={0.0001} max={10000} unit="mg/L" onChange={(v) => set('targetConc', v)} hint="e.g. in-vitro IC90 corrected for protein binding" /></div>
                </div>
              )}
            </div>
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="HED" value={fmt(fih.hedMgKg)} unit="mg/kg" />
            <Stat label="Max. recommended starting dose" value={fmt(fih.mrsdMg)} unit="mg" sub={`${fmt(fih.mrsdMgKg)} mg/kg`} tone="ok" />
            <Stat label="Predicted human t½" value={fmtHours(fih.halfLifeH)} sub={`CL ${fmt(fih.humanCL_Lh)} L/h · Vss ${fmt(fih.humanVss_L)} L`} />
            <Stat label="Projected efficacious dose" value={fmt(fih.efficaciousDoseMg)} unit="mg/day" sub={`${fmt(fih.marginToEfficacious)}× above MRSD`} tone={fih.marginToEfficacious > 100 ? 'warn' : undefined} />
          </div>
          <div className="grid gap-4 2xl:grid-cols-2">
            <Card title="Drug-likeness & developability">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={like.oralAbsorptionOutlook === 'good' ? 'ok' : like.oralAbsorptionOutlook === 'moderate' ? 'warn' : 'danger'}>Oral outlook: {like.oralAbsorptionOutlook}</Badge>
                <Badge tone="primary">BCS class {like.bcsClass}</Badge>
              </div>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-fg-2">Lipinski rule of five</p>
                  <ul className="space-y-1">{rule(c.mw <= 500, `MW ≤ 500 (${c.mw})`)}{rule(c.logP <= 5, `logP ≤ 5 (${c.logP})`)}{rule(c.hbd <= 5, `HBD ≤ 5 (${c.hbd})`)}{rule(c.hba <= 10, `HBA ≤ 10 (${c.hba})`)}</ul>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-fg-2">Veber rules</p>
                  <ul className="space-y-1">{rule(c.tpsa <= 140, `TPSA ≤ 140 (${c.tpsa})`)}{rule(c.rotatableBonds <= 10, `Rot. bonds ≤ 10 (${c.rotatableBonds})`)}</ul>
                </div>
              </div>
              {like.notes.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-4 text-sm text-fg-2">{like.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
            </Card>
            <Card title="Starting-dose derivation" subtitle="FDA Guidance for Industry (2005): body-surface-area conversion">
              <ol className="list-decimal space-y-1.5 pl-4 text-sm text-fg-2">{fih.method.map((m) => <li key={m} className="tabular">{m}</li>)}</ol>
            </Card>
          </div>
          <Card
            title={mad ? 'Multiple ascending dose (q24h × 7 days)' : 'Single ascending dose cohorts'}
            subtitle="Modified-Fibonacci escalation from the MRSD; one-compartment oral model."
            actions={<div className="w-56"><Switch checked={mad} onChange={setMad} label="Multiple dosing (MAD)" /></div>}
          >
            <TimeChart
              ariaLabel="Ascending dose cohort concentrations"
              t={cohorts[0].t}
              unit="mg/L"
              height={300}
              refLines={[{ y: c.targetConc, label: 'target' }]}
              series={cohorts.map((co, i) => ({ def: { key: `c${i}`, label: `${co.doseMg} mg`, color: colors[i] }, values: co.conc }))}
            />
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Cohort</th><th className="pb-1 font-medium">Dose</th><th className="pb-1 font-medium">Cmax</th><th className="pb-1 font-medium">AUC</th>{mad && <th className="pb-1 font-medium">Accumulation</th>}<th className="pb-1 font-medium">Reaches target</th></tr></thead>
                <tbody>
                  {cohorts.map((co, i) => (
                    <tr key={i} className="border-t border-line tabular">
                      <td className="py-1.5">{i + 1}</td><td>{co.doseMg} mg</td><td>{fmt(co.cmax)} mg/L</td><td>{fmt(co.auc)} mg·h/L</td>{mad && <td>{co.accumulation.toFixed(2)}×</td>}
                      <td>{co.aboveTarget ? <Badge tone="ok">yes</Badge> : <Badge>no</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
