import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity, Download, Pause, Play, Printer, Save, Sparkles, Wand2, HeartPulse, Gauge, TableIcon, LineChart as LineIcon } from 'lucide-react';
import {
  analyzeHistory, defaultPatient, derivePhysiology, evaluateAlerts, getDrug, makeRegimen, ORGANS, recommendDose, simulate,
  type DoseRecommendation, type Organ, type Patient, type Regimen, type SimulationResult,
} from '@medcare/engine';
import { get, post } from '../lib/api';
import { useTwins } from '../lib/twins';
import { useToast } from '../lib/toast';
import { downloadCsv, fmt, fmtHours } from '../lib/format';
import { Badge, Button, Callout, Card, Field, Input, Modal, NumberField, PageHeader, Stat, Switch, Tabs, cx } from '../components/ui';
import { AlertList, RegimenEditor, TwinPicker, useDrugColors } from '../components/clinical';
import { TimeChart } from '../components/charts';
import { BodyMap, type OrganState } from '../components/BodyMap';

type View = 'conc' | 'effect' | 'body' | 'qt' | 'table';

function closestIndex(t: number[], x: number) {
  let lo = 0;
  let hi = t.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (t[m] < x) lo = m;
    else hi = m;
  }
  return Math.abs(t[lo] - x) < Math.abs(t[hi] - x) ? lo : hi;
}

function narrative(sim: SimulationResult, fold: Record<string, number>): string[] {
  const out: string[] = [];
  for (const id of sim.drugIds) {
    const d = getDrug(id);
    const m = sim.metrics[id];
    const tss = Math.min(5 * m.halfLifeH, 24 * 365);
    let s = `${d.name}: effective half-life ${fmtHours(m.halfLifeH)}, so steady state takes ≈ ${fmtHours(tss)}.`;
    if (d.therapeutic && m.targetValue !== null) {
      const unit = d.therapeutic.basis === 'auc24' ? 'mg·h/L' : d.display.unit;
      s += ` Predicted ${d.therapeutic.basis} ${fmt(m.targetValue)} ${unit} is ${m.targetStatus === 'within' ? 'within' : m.targetStatus} the ${d.therapeutic.low}–${d.therapeutic.high} target.`;
    }
    if (fold[id] && Math.abs(fold[id] - 1) > 0.15) s += ` Co-medication changes its exposure ${fold[id].toFixed(2)}×.`;
    if (tss > sim.durationH * 1.2) s += ' Steady state is not reached within the simulated window — extend the duration or use a loading dose.';
    out.push(s);
  }
  return out;
}

export default function Simulator() {
  const [params] = useSearchParams();
  const { twins } = useTwins();
  const toast = useToast();
  const [twinId, setTwinId] = useState(params.get('twin') ?? '');
  const [regimens, setRegimens] = useState<Regimen[]>(() => [makeRegimen(params.get('drug') ?? 'vancomycin')]);
  const [includeHistory, setIncludeHistory] = useState(true);
  const [autoDuration, setAutoDuration] = useState(true);
  const [duration, setDuration] = useState(168);
  const [view, setView] = useState<View>('conc');
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [recs, setRecs] = useState<DoseRecommendation[] | null>(null);
  const [recBusy, setRecBusy] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);

  // Restore a saved experiment
  useEffect(() => {
    const exp = params.get('exp');
    if (!exp) return;
    get<{ simulation: { config: { regimens: Regimen[]; twinId?: string; durationH?: number; includeHistory?: boolean } } }>(`/simulations/${exp}`)
      .then((r) => {
        const c = r.simulation.config;
        if (Array.isArray(c.regimens)) setRegimens(c.regimens);
        if (c.twinId) setTwinId(c.twinId);
        if (c.durationH) {
          setAutoDuration(false);
          setDuration(c.durationH);
        }
        if (c.includeHistory !== undefined) setIncludeHistory(c.includeHistory);
      })
      .catch((e) => toast(e.message, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const twin = twins?.find((t) => t.id === twinId);
  const patient: Patient = useMemo(() => twin?.data ?? defaultPatient(), [twin]);
  const deferredRegs = useDeferredValue(regimens);
  const history = useMemo(() => (includeHistory && patient.medicationHistory.length ? analyzeHistory(patient) : null), [patient, includeHistory]);
  const durationH = autoDuration ? undefined : duration;

  const sim = useMemo(() => {
    if (!deferredRegs.length && !history?.carryOver) return null;
    try {
      return simulate({ patient, regimens: deferredRegs, durationH: durationH ?? (deferredRegs.length ? undefined : 168), initial: history?.carryOver ?? undefined });
    } catch (e) {
      console.error(e);
      return null;
    }
  }, [patient, deferredRegs, durationH, history]);

  const fold = useMemo(() => {
    const out: Record<string, number> = {};
    if (!sim || deferredRegs.length < 2) return out;
    for (const r of deferredRegs) {
      const solo = simulate({ patient, regimens: [r], durationH: sim.durationH, metricsOnly: true }).metrics[r.drugId];
      const both = sim.metrics[r.drugId];
      if (solo && both && solo.aucTotal > 0) out[r.drugId] = both.aucTotal / solo.aucTotal;
    }
    return out;
  }, [sim, deferredRegs, patient]);

  const phys = sim?.physiology ?? derivePhysiology(patient);
  const ids = sim?.drugIds ?? [];
  const colors = useDrugColors(ids);
  const alerts = useMemo(() => (sim ? evaluateAlerts(patient, phys, ids, sim) : []), [sim, patient, phys, ids]);
  useEffect(() => setRecs(null), [deferredRegs, patient]);

  // Time scrubber playback
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (!playing || !sim) return;
    const span = sim.durationH;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setCursor((c) => {
        const n = (c ?? 0) + (span / 12) * dt;
        if (n >= span) {
          setPlaying(false);
          return span;
        }
        return n;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [playing, sim]);

  const cursorH = cursor ?? (sim ? sim.durationH : 0);
  const ci = sim ? closestIndex(sim.t, cursorH) : 0;
  const organState = useMemo(() => {
    const o = {} as Record<Organ, OrganState>;
    for (const k of ORGANS) {
      const notes: string[] = [];
      for (const id of ids) for (const e of getDrug(id).organs) if (e.organ === k) notes.push(`${getDrug(id).name} — ${e.kind === 'target' ? 'acts on' : 'risk'}: ${e.note}`);
      o[k] = { therapeutic: sim?.organs[k].therapeutic[ci] ?? 0, risk: sim?.organs[k].risk[ci] ?? 0, notes };
    }
    return o;
  }, [sim, ci, ids]);
  const baseline = useMemo(() => {
    const b: Partial<Record<Organ, number>> = {};
    if (phys.crcl < 60) b.kidneys = Math.min(0.6, (60 - phys.crcl) / 80);
    if (phys.hepaticFactor < 0.85) b.liver = Math.min(0.6, 1 - phys.hepaticFactor);
    if (patient.heartFailure) b.heart = 0.3;
    return b;
  }, [phys, patient]);

  const qtPeak = sim ? Math.max(...sim.qtc) : 0;
  const nMajor = alerts.filter((a) => a.severity === 'major' || a.severity === 'contraindicated').length;

  const exportCsv = () => {
    if (!sim) return;
    const header = ['time_h', ...ids.flatMap((id) => [`${id}_${getDrug(id).display.unit}`, ...(sim.series[id].effect ? [`${id}_effect`] : [])]), 'QTc_ms'];
    const rows = sim.t.map((t, i) => [t.toFixed(3), ...ids.flatMap((id) => [sim.series[id].conc[i].toPrecision(5), ...(sim.series[id].effect ? [sim.series[id].effect![i].toPrecision(4)] : [])]), sim.qtc[i].toFixed(1)]);
    downloadCsv(`medcare-simulation-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...rows]);
  };

  const suggest = () => {
    setRecBusy(true);
    setTimeout(() => {
      const out: DoseRecommendation[] = [];
      for (const r of regimens) {
        const rec = recommendDose(patient, regimens, r.drugId, { durationH, initial: history?.carryOver ?? undefined });
        if (rec) out.push(rec);
      }
      setRecs(out);
      setRecBusy(false);
    }, 20);
  };

  const save = async () => {
    if (!sim) return;
    setSaving(true);
    try {
      await post('/simulations', {
        name: saveName.trim() || `Simulation ${new Date().toLocaleString()}`,
        kind: 'simulation',
        twinId: twinId || undefined,
        config: { regimens, twinId: twinId || undefined, durationH, includeHistory },
        summary: {
          patient: patient.name,
          drugs: ids.map((id) => getDrug(id).name),
          alerts: alerts.length,
          major: nMajor,
          metrics: Object.fromEntries(ids.map((id) => [id, { auc24: sim.metrics[id].auc24, cmax: sim.metrics[id].cmax, status: sim.metrics[id].targetStatus }])),
        },
      });
      toast('Experiment saved');
      setSaveOpen(false);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        icon={<Activity className="size-5" />}
        title="Drug simulator"
        description="Predict how one or more medicines are absorbed, distributed, metabolised and eliminated in this twin — and what they do to its organs."
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button variant="secondary" icon={<Download className="size-4" />} onClick={exportCsv} disabled={!sim}>CSV</Button>
            <Button variant="secondary" icon={<Printer className="size-4" />} onClick={() => window.print()} disabled={!sim}>Report</Button>
            <Button icon={<Save className="size-4" />} onClick={() => { setSaveName(`${patient.name}: ${ids.map((i) => getDrug(i).name).join(' + ')}`); setSaveOpen(true); }} disabled={!sim}>Save</Button>
          </div>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        <div className="flex flex-col gap-4 xl:sticky xl:top-20 xl:h-fit print:hidden">
          <Card title="Patient twin">
            <div className="flex flex-col gap-3">
              <Field label="Twin" htmlFor="twin">
                <TwinPicker id="twin" twins={twins} value={twinId} onChange={setTwinId} />
              </Field>
              <div className="flex flex-wrap gap-1.5">
                <Badge tone={phys.crcl < 30 ? 'danger' : phys.crcl < 60 ? 'warn' : 'neutral'}>CrCl {Math.round(phys.crcl)} mL/min</Badge>
                <Badge tone={phys.hepaticFactor < 0.6 ? 'danger' : phys.hepaticFactor < 0.85 ? 'warn' : 'neutral'}>Hepatic {Math.round(phys.hepaticFactor * 100)}%</Badge>
                {phys.absorptionFactor < 0.95 && <Badge tone="warn">Absorption {Math.round(phys.absorptionFactor * 100)}%</Badge>}
                {Object.entries(patient.phenotypes).filter(([k, v]) => v !== 'NM' && !(k === 'CYP3A5' && v === 'PM')).map(([k, v]) => <Badge key={k} tone="info">{k} {v}</Badge>)}
              </div>
              {patient.medicationHistory.length > 0 && (
                <Switch checked={includeHistory} onChange={setIncludeHistory} label="Include medication history" description="Carry over residual drug and enzyme induction/inhibition from past courses." />
              )}
              {twin && <Link to={`/app/twins/${twin.id}`} className="text-xs font-medium text-primary hover:underline">Edit twin →</Link>}
            </div>
          </Card>
          <Card title="Regimens" subtitle="Up to 6 concurrent medicines">
            <RegimenEditor regimens={regimens} onChange={setRegimens} colors={colors} />
            <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
              <Switch checked={autoDuration} onChange={setAutoDuration} label="Auto duration" description="Simulate until the last dose interval ends." />
              {!autoDuration && <NumberField label="Duration" value={duration} min={1} max={2160} unit="h" onChange={setDuration} hint={`${(duration / 24).toFixed(1)} days`} />}
            </div>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {!sim ? (
            <Callout tone="info" title="Add a medicine to begin">Choose a medicine in the regimen panel. Results update instantly as you change doses.</Callout>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Alerts" value={alerts.length} sub={nMajor ? `${nMajor} major / contraindicated` : 'none major'} tone={nMajor ? 'danger' : alerts.length ? 'warn' : 'ok'} />
                <Stat label="Peak QTc" value={Math.round(qtPeak)} unit="ms" sub={`baseline ${phys.baselineQTc}`} tone={qtPeak >= 500 ? 'danger' : qtPeak >= 470 ? 'warn' : undefined} />
                <Stat label="Medicines on target" value={`${ids.filter((i) => sim.metrics[i].targetStatus === 'within').length}/${ids.filter((i) => sim.metrics[i].targetStatus !== 'n/a').length}`} />
                <Stat label="Simulated" value={fmtHours(sim.durationH)} sub={history?.carryOver ? 'with history carry-over' : undefined} />
              </div>

              <Card bodyClass="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
                  <Tabs<View>
                    label="Result views"
                    value={view}
                    onChange={setView}
                    tabs={[
                      { id: 'conc', label: 'Concentrations', icon: <LineIcon className="size-4" /> },
                      { id: 'effect', label: 'Effects', icon: <Gauge className="size-4" /> },
                      { id: 'body', label: 'Body map', icon: <HeartPulse className="size-4" /> },
                      { id: 'qt', label: 'QTc & enzymes', icon: <Activity className="size-4" /> },
                      { id: 'table', label: 'Metrics', icon: <TableIcon className="size-4" /> },
                    ]}
                  />
                </div>
                <div className="mt-4 flex items-center gap-3 print:hidden">
                  <Button size="sm" variant="secondary" aria-label={playing ? 'Pause playback' : 'Play time course'} icon={playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} onClick={() => { if (!playing && cursorH >= sim.durationH) setCursor(0); setPlaying((p) => !p); }}>
                    {playing ? 'Pause' : 'Play'}
                  </Button>
                  <input type="range" aria-label="Time point" min={0} max={sim.durationH} step={sim.durationH / 400} value={cursorH} onChange={(e) => { setPlaying(false); setCursor(Number(e.target.value)); }} className="flex-1" />
                  <span className="w-28 text-right text-xs text-muted tabular">t = {fmtHours(cursorH)}</span>
                </div>

                {view === 'conc' && (
                  <div className="mt-4 grid gap-5 2xl:grid-cols-2">
                    {ids.map((id) => {
                      const d = getDrug(id);
                      const s = sim.series[id];
                      const m = sim.metrics[id];
                      const thr = d.therapeutic && d.therapeutic.basis !== 'auc24' ? { low: d.therapeutic.low, high: d.therapeutic.high, label: `target ${d.therapeutic.basis}` } : undefined;
                      const toxic = d.toxic && d.toxic.basis !== 'auc24' ? { value: d.toxic.value, label: `toxic (${d.toxic.basis})` } : undefined;
                      return (
                        <div key={id}>
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <p className="flex items-center gap-2 text-sm font-semibold"><span className="size-2.5 rounded-full" style={{ background: colors(id) }} aria-hidden />{d.name}</p>
                            <p className="text-xs text-muted tabular">
                              now {fmt(s.conc[ci])} {d.display.unit}
                              {m.targetStatus !== 'n/a' && <> · <Badge tone={m.targetStatus === 'within' ? 'ok' : 'warn'}>{m.targetStatus}</Badge></>}
                              {m.toxicStatus === 'toxic' && <> <Badge tone="danger">toxic</Badge></>}
                              {fold[id] && Math.abs(fold[id] - 1) > 0.15 && <> <Badge tone="info">DDI ×{fold[id].toFixed(2)}</Badge></>}
                            </p>
                          </div>
                          <TimeChart
                            ariaLabel={`${d.name} plasma concentration over time`}
                            t={sim.t}
                            unit={d.display.unit}
                            cursorH={cursorH}
                            band={thr}
                            toxic={toxic}
                            series={[
                              { def: { key: 'c', label: d.prodrug ? 'Parent drug' : d.name, color: colors(id) }, values: s.conc },
                              ...(s.active ? [{ def: { key: 'a', label: `${d.prodrug!.activeMoiety} (equiv.)`, color: colors(id), dash: '5 4' }, values: s.active }] : []),
                            ]}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}

                {view === 'effect' && (
                  <div className="mt-4 grid gap-5 2xl:grid-cols-2">
                    {ids.filter((id) => sim.series[id].effect).map((id) => {
                      const d = getDrug(id);
                      const pd = d.pd!;
                      const base = pd.unit === 'bpm' && pd.E0 === 0 ? phys.baselineHR : pd.unit === 'mmHg' && pd.E0 === 0 ? phys.baselineSBP : null;
                      const vals = sim.series[id].effect!.map((v) => (base !== null ? base + v : v));
                      const label = base !== null ? (pd.unit === 'bpm' ? 'Heart rate' : 'Systolic BP') : pd.effect;
                      return (
                        <div key={id}>
                          <p className="text-sm font-semibold">{d.name}: {label}</p>
                          <p className="text-xs text-muted">Effect-site model (ke0 {pd.ke0} h⁻¹), sigmoid Emax. Now {fmt(vals[ci])} {pd.unit}</p>
                          <TimeChart ariaLabel={`${d.name} effect over time`} t={sim.t} unit={pd.unit || 'effect'} cursorH={cursorH} yDomain={['auto', 'auto']} series={[{ def: { key: 'e', label, color: colors(id) }, values: vals }]} refLines={id === 'warfarin' ? [{ y: 2, label: 'INR 2' }, { y: 3, label: 'INR 3' }] : undefined} />
                        </div>
                      );
                    })}
                    {!ids.some((id) => sim.series[id].effect) && <p className="text-sm text-muted">No pharmacodynamic model for the selected medicines.</p>}
                  </div>
                )}

                {view === 'body' && (
                  <div className="mt-4">
                    <BodyMap organs={organState} baseline={baseline} />
                    <p className="mt-3 text-xs text-muted">Organ colours show the strongest modelled toxicity risk (red) or therapeutic engagement (blue) at the selected time; baseline organ impairment is included. Press Play to watch effects evolve.</p>
                  </div>
                )}

                {view === 'qt' && (
                  <div className="mt-4 grid gap-5 2xl:grid-cols-2">
                    <div>
                      <p className="text-sm font-semibold">Predicted QTc</p>
                      <p className="text-xs text-muted">Additive concentration–QTc model{patient.potassium < 3.5 ? ', +10 ms for hypokalaemia' : ''}.</p>
                      <TimeChart ariaLabel="Predicted QTc" t={sim.t} unit="ms" cursorH={cursorH} yDomain={[Math.min(380, phys.baselineQTc - 10), 'auto']} series={[{ def: { key: 'q', label: 'QTc', color: 'var(--s7)' }, values: sim.qtc }]} refLines={[{ y: 470, label: '470 ms' }, { y: 500, label: '500 ms' }]} />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">Metabolic pathway activity</p>
                      <p className="text-xs text-muted">Genotype × inhibition × induction (1 = reference). Induction develops over days.</p>
                      <TimeChart
                        ariaLabel="Enzyme activity over time"
                        t={sim.t}
                        unit="× ref"
                        cursorH={cursorH}
                        yDomain={[0, 'auto']}
                        series={Object.entries(sim.enzymes)
                          .filter(([k, v]) => k !== 'CYP3A5' && v.some((x) => Math.abs(x - 1) > 0.05))
                          .slice(0, 6)
                          .map(([k, v], i) => ({ def: { key: k, label: k, color: `var(--s${((i + 3) % 8) + 1})` }, values: v }))}
                      />
                    </div>
                  </div>
                )}

                {view === 'table' && (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full min-w-[720px] text-sm">
                      <caption className="sr-only">Pharmacokinetic metrics</caption>
                      <thead>
                        <tr className="text-left text-xs text-muted">
                          {['Medicine', 'Dose', 'Cmax', 'Tmax', 'Trough', 'Avg (last τ)', 'AUC₂₄', 't½', 'CL', 'In range', 'Status'].map((h) => <th key={h} className="pb-2 pr-3 font-medium">{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {ids.map((id) => {
                          const m = sim.metrics[id];
                          const d = getDrug(id);
                          return (
                            <tr key={id} className="border-t border-line tabular">
                              <td className="py-2 pr-3 font-medium">{d.name}</td>
                              <td className="py-2 pr-3">{fmt(m.doseMg)} mg q{m.intervalH}h</td>
                              <td className="py-2 pr-3">{fmt(m.cmax)} {m.unit}</td>
                              <td className="py-2 pr-3">{fmtHours(m.tmax)}</td>
                              <td className="py-2 pr-3">{fmt(m.troughLast)}</td>
                              <td className="py-2 pr-3">{fmt(m.avgLast)}</td>
                              <td className="py-2 pr-3">{fmt(m.auc24)}</td>
                              <td className="py-2 pr-3">{fmtHours(m.halfLifeH)}</td>
                              <td className="py-2 pr-3">{fmt(m.clearanceLh)} L/h</td>
                              <td className="py-2 pr-3">{m.timeInRangePct !== null ? `${m.timeInRangePct.toFixed(0)}%` : '—'}</td>
                              <td className="py-2 pr-3">
                                {m.toxicStatus === 'toxic' ? <Badge tone="danger">toxic</Badge> : m.targetStatus === 'within' ? <Badge tone="ok">on target</Badge> : m.targetStatus === 'n/a' ? <Badge>no target</Badge> : <Badge tone="warn">{m.targetStatus}</Badge>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              <div className="grid gap-4 2xl:grid-cols-2">
                <Card title="Clinical decision support" subtitle="Interactions, pharmacogenomics, organ function and predicted exposure">
                  <AlertList alerts={alerts} />
                </Card>
                <div className="flex flex-col gap-4">
                  <Card
                    title="Dose individualisation"
                    actions={<Button size="sm" variant="secondary" icon={<Wand2 className="size-3.5" />} onClick={suggest} loading={recBusy}>Suggest doses</Button>}
                  >
                    {!recs ? (
                      <p className="text-sm text-muted">Finds the dose that centres each medicine’s therapeutic metric in its target range for this twin, accounting for interactions and non-linear kinetics.</p>
                    ) : recs.length === 0 ? (
                      <p className="text-sm text-muted">No medicines with a defined therapeutic target.</p>
                    ) : (
                      <ul className="flex flex-col gap-3">
                        {recs.map((r) => (
                          <li key={r.drugId} className="rounded-xl border border-line p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-sm font-semibold">{getDrug(r.drugId).name}</p>
                              {r.recommendedDose !== r.currentDose ? (
                                <Button size="sm" onClick={() => { setRegimens(regimens.map((x) => (x.drugId === r.drugId ? { ...x, dose: r.recommendedDose } : x))); toast(`Applied ${r.recommendedDose} ${r.unit} to ${getDrug(r.drugId).name}`); }}>
                                  Apply {r.recommendedDose} {r.unit}
                                </Button>
                              ) : <Badge tone="ok">No change</Badge>}
                            </div>
                            <p className="mt-1 text-xs text-fg-2">{r.rationale}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                  <Card title="What is happening" actions={<Sparkles className="size-4 text-primary" aria-hidden />}>
                    <ul className="list-disc space-y-1.5 pl-4 text-sm text-fg-2">
                      {narrative(sim, fold).map((n) => <li key={n}>{n}</li>)}
                      {phys.notes.map((n) => <li key={n}>{n}</li>)}
                    </ul>
                  </Card>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save experiment" footer={<><Button variant="secondary" onClick={() => setSaveOpen(false)}>Cancel</Button><Button loading={saving} onClick={save}>Save</Button></>}>
        <Field label="Name" htmlFor="sname">
          <Input id="sname" value={saveName} maxLength={120} onChange={(e) => setSaveName(e.target.value)} />
        </Field>
        <p className="mt-2 text-xs text-muted">Saves the regimen, twin reference and a metrics summary. Re-open it from Saved experiments.</p>
      </Modal>
    </div>
  );
}
