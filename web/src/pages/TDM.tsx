import { useMemo, useState } from 'react';
import { Sigma, Plus, Trash2, Wand2 } from 'lucide-react';
import { bayesianEstimate, defaultPatient, DRUGS, getDrug, makeRegimen, recommendDose, simulate, type BayesResult, type DoseRecommendation, type Regimen } from '@medcare/engine';
import { useTwins } from '../lib/twins';
import { useToast } from '../lib/toast';
import { post } from '../lib/api';
import { fmt, fmtHours, uid } from '../lib/format';
import { Button, Callout, Card, Field, NumberField, PageHeader, Stat } from '../components/ui';
import { DrugSelect, RegimenEditor, TwinPicker } from '../components/clinical';
import { TimeChart } from '../components/charts';

const TDM_DRUGS = DRUGS.filter((d) => d.therapeutic && !d.pk.mm).map((d) => d.id);

export default function TDM() {
  const { twins } = useTwins();
  const toast = useToast();
  const [twinId, setTwinId] = useState('');
  const [drugId, setDrugId] = useState('vancomycin');
  const [regs, setRegs] = useState<Regimen[]>([makeRegimen('vancomycin', { doses: 6 })]);
  const [obs, setObs] = useState<{ id: string; timeH: number; value: number }[]>([
    { id: 'o1', timeH: 61, value: 32 },
    { id: 'o2', timeH: 71.5, value: 21 },
  ]);
  const [fit, setFit] = useState<BayesResult | null>(null);
  const [rec, setRec] = useState<DoseRecommendation | null>(null);
  const [busy, setBusy] = useState(false);
  const patient = twins?.find((t) => t.id === twinId)?.data ?? defaultPatient();
  const drug = getDrug(drugId);
  const dur = Math.max(...regs.map((r) => r.startH + r.doses * r.intervalH), ...obs.map((o) => o.timeH + 1));
  const invalid = obs.some((o) => o.timeH > dur || o.timeH <= 0);

  const run = () => {
    setBusy(true);
    setTimeout(() => {
      try {
        const f = bayesianEstimate(patient, regs, drugId, obs);
        setFit(f);
        const next = regs.map((r) => ({ ...r, doses: r.doses + Math.round(72 / r.intervalH) }));
        setRec(recommendDose(patient, next, drugId, { etas: { [drugId]: f.eta } }));
      } catch (e) {
        toast((e as Error).message, 'error');
      } finally {
        setBusy(false);
      }
    }, 20);
  };

  const curves = useMemo(() => {
    if (!fit) return null;
    const pop = simulate({ patient, regimens: regs, durationH: dur });
    const ind = simulate({ patient, regimens: regs, durationH: dur, etas: { [drugId]: fit.eta } });
    return { t: pop.t, pop: pop.series[drugId].conc, ind: ind.series[drugId].conc, tInd: ind.t };
  }, [fit, patient, regs, dur, drugId]);

  const forecast = useMemo(() => {
    if (!fit || !rec) return null;
    const regimen = regs.find((r) => r.drugId === drugId)!;
    const r2: Regimen = { ...regimen, id: 'next', dose: rec.recommendedDose, startH: regimen.startH + regimen.doses * regimen.intervalH, doses: Math.round(96 / regimen.intervalH), loadingDose: undefined };
    const s = simulate({ patient, regimens: [...regs, r2], durationH: r2.startH + r2.doses * r2.intervalH, etas: { [drugId]: fit.eta } });
    return s;
  }, [fit, rec, regs, patient, drugId]);

  return (
    <div>
      <PageHeader
        icon={<Sigma className="size-5" />}
        title="Bayesian precision dosing"
        description="Model-informed precision dosing: combine population priors with measured drug levels (maximum a posteriori estimation) to individualise clearance and volume, then forecast the next regimen."
      />
      <div className="grid gap-6 xl:grid-cols-[400px_1fr]">
        <div className="flex flex-col gap-4">
          <Card title="1. Patient & medicine">
            <div className="flex flex-col gap-3">
              <Field label="Twin" htmlFor="tw"><TwinPicker id="tw" twins={twins} value={twinId} onChange={(v) => { setTwinId(v); setFit(null); }} /></Field>
              <Field label="Medicine" htmlFor="dr">
                <DrugSelect id="dr" value={drugId} onChange={(id) => {
                  if (!TDM_DRUGS.includes(id)) { toast('Choose a medicine with a therapeutic target and linear kinetics', 'info'); return; }
                  setDrugId(id); setRegs([makeRegimen(id, { doses: 6 })]); setFit(null); setObs([]);
                }} />
              </Field>
              <p className="text-xs text-muted">Target: {drug.therapeutic?.basis} {drug.therapeutic?.low}–{drug.therapeutic?.high} {drug.therapeutic?.basis === 'auc24' ? 'mg·h/L' : drug.display.unit}</p>
            </div>
          </Card>
          <Card title="2. Doses given">
            <RegimenEditor regimens={regs.filter((r) => r.drugId === drugId)} onChange={(r) => { setRegs(r.length ? r : regs); setFit(null); }} colors={() => 'var(--s1)'} max={1} />
          </Card>
          <Card title="3. Measured levels" subtitle={`Time from first dose (h) and concentration (${drug.display.unit}).`}>
            <ul className="flex flex-col gap-2">
              {obs.map((o, i) => (
                <li key={o.id} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                  <NumberField label={`Level ${i + 1} time`} value={o.timeH} min={0.1} max={8760} unit="h" onChange={(v) => { setObs(obs.map((x) => (x.id === o.id ? { ...x, timeH: v } : x))); setFit(null); }} />
                  <NumberField label="Concentration" value={o.value} min={0} max={1e5} unit={drug.display.unit} onChange={(v) => { setObs(obs.map((x) => (x.id === o.id ? { ...x, value: v } : x))); setFit(null); }} />
                  <button className="mb-2 rounded-md p-2 text-muted hover:bg-danger-soft hover:text-danger" aria-label={`Remove level ${i + 1}`} onClick={() => setObs(obs.filter((x) => x.id !== o.id))}><Trash2 className="size-4" /></button>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" size="sm" icon={<Plus className="size-3.5" />} disabled={obs.length >= 10} onClick={() => setObs([...obs, { id: uid('o'), timeH: Math.round(dur - 1), value: drug.therapeutic && drug.therapeutic.basis !== 'auc24' ? drug.therapeutic.low : 15 }])}>Add level</Button>
            </div>
            {invalid && <p className="mt-2 text-xs text-danger">Each level must be after the first dose and within the dosing history.</p>}
            <Button className="mt-4 w-full" icon={<Wand2 className="size-4" />} onClick={run} loading={busy} disabled={!obs.length || invalid}>Estimate & recommend</Button>
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {!fit ? (
            <Callout tone="info" title="How it works">
              Population PK parameters (adjusted for this twin’s weight, renal and hepatic function and genotype) form the prior. Measured levels update them via Bayes’ theorem: the objective function balances fit to the data against deviation from the population (log-normal inter-individual variability, proportional + additive residual error). With one level the result stays close to the prior; with two or more, it is driven by the data.
            </Callout>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Individual CL" value={fmt(fit.individual.CL)} unit="L/h" sub={`population ${fmt(fit.population.CL)} · 90% CrI ${fmt(fit.clInterval[0])}–${fmt(fit.clInterval[1])}`} />
                <Stat label="Individual V" value={fmt(fit.individual.V)} unit="L" sub={`population ${fmt(fit.population.V)}`} />
                <Stat label="Half-life" value={fmtHours(fit.individual.halfLifeH)} sub={`population ${fmtHours(fit.population.halfLifeH)}`} />
                <Stat label="Recommended" value={rec ? `${rec.recommendedDose}` : '—'} unit={rec ? `${rec.unit} q${rec.intervalH}h` : ''} sub={rec ? `predicted ${rec.basis} ${fmt(rec.predictedValue)}` : ''} tone="ok" />
              </div>
              <Card title="Fit to measured levels" subtitle={fit.shrinkageNote}>
                {curves && (
                  <TimeChart
                    ariaLabel="Population and individual predicted concentrations with measured levels"
                    t={curves.t}
                    unit={drug.display.unit}
                    series={[
                      { def: { key: 'pop', label: 'Population prediction', color: 'var(--muted)', dash: '5 4' }, values: curves.pop },
                      { def: { key: 'ind', label: 'Individual (Bayesian)', color: 'var(--s1)' }, values: curves.ind },
                    ]}
                    observations={obs.map((o) => ({ t: o.timeH, v: o.value }))}
                  />
                )}
                <table className="mt-3 w-full text-sm">
                  <thead><tr className="text-left text-xs text-muted"><th className="font-medium">Time</th><th className="font-medium">Observed</th><th className="font-medium">Individual pred.</th><th className="font-medium">Population pred.</th></tr></thead>
                  <tbody>
                    {fit.fitted.map((f) => (
                      <tr key={f.timeH} className="border-t border-line tabular"><td className="py-1">{fmt(f.timeH)} h</td><td>{fmt(f.observed)}</td><td>{fmt(f.predicted)}</td><td className="text-muted">{fmt(f.populationPredicted)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              {rec && forecast && (
                <Card
                  title="Forecast with recommended regimen"
                  subtitle={rec.rationale}
                  actions={<Button size="sm" variant="secondary" onClick={() => post('/simulations', { name: `TDM ${drug.name} — ${patient.name}`, kind: 'tdm', twinId: twinId || undefined, config: { drugId, regs, obs }, summary: { CL: fit.individual.CL, V: fit.individual.V, recommended: rec.recommendedDose, unit: rec.unit } }).then(() => toast('Saved to experiments')).catch((e) => toast(e.message, 'error'))}>Save</Button>}
                >
                  <TimeChart
                    ariaLabel="Forecast concentrations"
                    t={forecast.t}
                    unit={drug.display.unit}
                    band={drug.therapeutic && drug.therapeutic.basis !== 'auc24' ? { low: drug.therapeutic.low, high: drug.therapeutic.high, label: 'target' } : undefined}
                    series={[{ def: { key: 'f', label: 'Forecast', color: 'var(--s3)' }, values: forecast.series[drugId].conc }]}
                    observations={obs.map((o) => ({ t: o.timeH, v: o.value }))}
                  />
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
