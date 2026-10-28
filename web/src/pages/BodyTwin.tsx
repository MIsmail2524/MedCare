import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Pause, Play, RotateCcw, Sparkles, BrainCircuit, ClipboardPlus, Rotate3D, Activity, HeartPulse, Wand2, Plus, Trash2 } from 'lucide-react';
import {
  analyzeHistory, defaultPatient, evaluateAlerts, getDrug, learnedEtas, makeRegimen, ORGANS, predictSideEffects, recommendFromPolicy,
  RL_STATUSES, simulate, defaultAEModel,
  type LearnedModel, type Organ, type Patient, type Regimen, type RLStatus, type SideEffectPrediction,
} from '@medcare/engine';
import { get, post } from '../lib/api';
import { useTwins } from '../lib/twins';
import { useToast } from '../lib/toast';
import { fmt, fmtHours, uid } from '../lib/format';
import { Badge, Button, Callout, Card, Field, Modal, NumberField, PageHeader, Select, Switch, cx } from '../components/ui';
import { DrugSelect, RegimenEditor, ROUTE_LABEL, TwinPicker, useDrugColors } from '../components/clinical';
import { BodyTwin3D, COMPARTMENTS, webglSupported, type BodyFrame, type Compartment } from '../components/BodyTwin3D';
import { BodyMap, ORGAN_LABEL } from '../components/BodyMap';
import { TimeChart } from '../components/charts';

const COMP_LABEL: Record<Compartment, string> = {
  gut: 'In GI tract (being absorbed)',
  firstPass: 'Removed by first-pass (gut wall / liver)',
  plasma: 'Circulating in blood',
  tissue: 'Distributed in tissues & organs',
  metabolised: 'Metabolised (mainly liver)',
  excreted: 'Excreted unchanged (kidneys)',
};
const COMP_COLOR: Record<Compartment, string> = {
  gut: 'var(--s4)',
  firstPass: '#8b93a7',
  plasma: 'var(--s1)',
  tissue: 'var(--s3)',
  metabolised: '#b48cff',
  excreted: '#e0b100',
};

interface TwinEvent {
  t: number;
  title: string;
  detail: string;
  tone: 'info' | 'ok' | 'warn' | 'danger';
}

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

function RichText({ text }: { text: string }) {
  // Minimal, safe Markdown-ish rendering (no HTML injection): headings, bullets, bold.
  const lines = text.split('\n');
  const bold = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>));
  return (
    <div className="space-y-1.5 text-sm text-fg-2">
      {lines.map((l, i) => {
        const tline = l.trim();
        if (!tline) return null;
        if (/^#{1,4}\s/.test(tline)) return <p key={i} className="pt-1 font-semibold text-fg">{bold(tline.replace(/^#+\s/, ''))}</p>;
        if (/^[-*•]\s/.test(tline)) return <p key={i} className="flex gap-2 pl-1"><span aria-hidden>•</span><span>{bold(tline.replace(/^[-*•]\s/, ''))}</span></p>;
        return <p key={i}>{bold(tline)}</p>;
      })}
    </div>
  );
}

export default function BodyTwin() {
  const [params] = useSearchParams();
  const toast = useToast();
  const { twins } = useTwins();
  const [twinId, setTwinId] = useState(params.get('twin') ?? '');
  const [regimens, setRegimens] = useState<Regimen[]>(() => [makeRegimen(params.get('drug') ?? 'acetaminophen', { doses: 4 })]);
  const [focus, setFocus] = useState<string>(params.get('drug') ?? 'acetaminophen');
  const [includeHistory, setIncludeHistory] = useState(true);
  const [useLearned, setUseLearned] = useState(true);
  const [model, setModel] = useState<LearnedModel | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rotate, setRotate] = useState(true);
  const [hoverOrgan, setHoverOrgan] = useState<Organ | null>(null);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [ai, setAi] = useState<{ text: string; model: string } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const [webgl] = useState(webglSupported);

  const loadModel = useCallback(() => get<{ model: LearnedModel }>('/learning/model').then((r) => setModel(r.model)).catch(() => setModel(null)), []);
  useEffect(() => {
    void loadModel();
    get<{ enabled: boolean }>('/ai/status').then((r) => setAiEnabled(r.enabled)).catch(() => setAiEnabled(false));
  }, [loadModel]);

  const twin = twins?.find((t) => t.id === twinId);
  const patient: Patient = useMemo(() => twin?.data ?? defaultPatient(), [twin]);
  const regs = useDeferredValue(regimens);
  const history = useMemo(() => (includeHistory && patient.medicationHistory.length ? analyzeHistory(patient) : null), [patient, includeHistory]);
  const ids = useMemo(() => Array.from(new Set(regs.map((r) => r.drugId))), [regs]);
  const etas = useMemo(() => (useLearned ? learnedEtas(model, ids) : undefined), [useLearned, model, ids]);
  const aeModel = useLearned && model ? model.ae : defaultAEModel();

  const sim = useMemo(() => {
    if (!regs.length) return null;
    try {
      return simulate({ patient, regimens: regs, etas, initial: history?.carryOver ?? undefined });
    } catch {
      return null;
    }
  }, [patient, regs, etas, history]);
  const sideEffects = useMemo<SideEffectPrediction[]>(() => (sim ? predictSideEffects(sim, patient, aeModel) : []), [sim, patient, aeModel]);
  const alerts = useMemo(() => (sim ? evaluateAlerts(patient, sim.physiology, sim.drugIds, sim) : []), [sim, patient]);
  const colors = useDrugColors(ids);
  const focusId = sim?.drugIds.includes(focus) ? focus : sim?.drugIds[0] ?? focus;
  const drug = getDrug(focusId);
  useEffect(() => setCursor(0), [regs, patient]);

  // playback: whole course in ~24 s
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (!playing || !sim) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setCursor((c) => {
        const n = c + (sim.durationH / 24) * dt;
        if (n >= sim.durationH) {
          setPlaying(false);
          return sim.durationH;
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

  const ci = sim ? closestIndex(sim.t, cursor) : 0;
  const journey = sim?.series[focusId]?.journey;
  const jTotals = useMemo(() => {
    if (!journey) return null;
    const tot = journey.gut.map((_, k) => COMPARTMENTS.reduce((s, c) => s + journey[c][k], 0));
    return { tot, final: Math.max(tot[tot.length - 1], 1e-9) };
  }, [journey]);

  const frame: BodyFrame | null = useMemo(() => {
    if (!sim || !journey || !jTotals) return null;
    const organs = Object.fromEntries(
      ORGANS.map((o) => {
        const se = sideEffects.filter((s) => s.organ === o).reduce((m, s) => Math.max(m, s.timeline[ci] ?? 0), 0);
        return [o, { therapeutic: sim.organs[o].therapeutic[ci] ?? 0, risk: Math.max(sim.organs[o].risk[ci] ?? 0, se) }];
      }),
    ) as BodyFrame['organs'];
    const j = Object.fromEntries(COMPARTMENTS.map((c) => [c, journey[c][ci] / jTotals.final])) as Record<Compartment, number>;
    const pd = drug.pd;
    const hrEff = pd && pd.unit === 'bpm' ? sim.series[focusId].effect?.[ci] ?? 0 : 0;
    return {
      organs,
      journey: j,
      dosedFraction: jTotals.tot[ci] / jTotals.final,
      heartRate: Math.max(35, sim.physiology.baselineHR + hrEff),
      breathing: Math.max(0.2, 1 - 0.8 * (organs.lungs.risk ?? 0)),
      callouts: sideEffects
        .filter((s) => (s.timeline[ci] ?? 0) >= 0.15)
        .map((s) => ({ organ: s.organ, label: `${getDrug(s.drugId).name.split(' ')[0]}: ${s.name} · ${Math.round(s.timeline[ci] * 100)}%`, severity: s.timeline[ci] >= 0.5 ? 'severe' as const : s.timeline[ci] >= 0.2 ? 'moderate' as const : 'mild' as const })),
      targetOrgans: drug.organs.filter((o) => o.kind === 'target').map((o) => o.organ),
    };
  }, [sim, journey, jTotals, ci, sideEffects, drug, focusId]);

  const events = useMemo<TwinEvent[]>(() => {
    if (!sim || !journey || !jTotals) return [];
    const ev: TwinEvent[] = [];
    const m = sim.metrics[focusId];
    const reg = regs.find((r) => r.drugId === focusId);
    const last = journey.gut.length - 1;
    if (reg) ev.push({ t: reg.startH, title: reg.route === 'po' ? `Swallowed ${reg.dose} ${reg.unit} ${drug.name}` : `${ROUTE_LABEL[reg.route]} ${reg.dose} ${reg.unit} ${drug.name}`, detail: `${reg.doses} dose${reg.doses > 1 ? 's' : ''} every ${reg.intervalH} h.`, tone: 'info' });
    if (reg?.route === 'po' || reg?.route === 'sc') {
      const gutPeak = journey.gut.indexOf(Math.max(...journey.gut.slice(0, Math.max(2, closestIndex(sim.t, reg.intervalH)))));
      const fp = (100 * journey.firstPass[last]) / jTotals.final;
      ev.push({ t: Math.max(sim.t[gutPeak] ?? 0.5, 0.25), title: reg.route === 'po' ? 'Dissolving & absorbed in the small intestine' : 'Absorbed from the injection depot', detail: fp > 1 ? `Portal blood carries it to the liver, where first-pass extraction removes ≈ ${fp.toFixed(0)}% before it reaches the circulation.` : 'Little first-pass loss — most of the dose reaches the circulation.', tone: 'info' });
    }
    const conc = sim.series[focusId].conc;
    const firstEnd = closestIndex(sim.t, (reg?.startH ?? 0) + (reg?.intervalH ?? 24));
    let fp = 0;
    for (let k = 1; k <= firstEnd; k++) if (conc[k] > conc[fp]) fp = k;
    ev.push({ t: sim.t[fp], title: `First peak in blood ${fmt(conc[fp])} ${m.unit}`, detail: `The drug distributes into tissues (${fmt(m.volumeL)} L apparent volume); effective half-life ${fmtHours(m.halfLifeH)}.`, tone: 'ok' });
    if ((reg?.doses ?? 1) > 1 && m.cmax > conc[fp] * 1.1) ev.push({ t: m.tmax, title: `Highest level ${fmt(m.cmax)} ${m.unit} (accumulation)`, detail: `Repeated doses accumulate ${(m.cmax / conc[fp]).toFixed(1)}× above the first peak.`, tone: m.toxicStatus === 'toxic' ? 'danger' : 'info' });
    const tss = 4.5 * m.halfLifeH;
    if (tss < sim.durationH && (reg?.doses ?? 1) > 1) ev.push({ t: tss, title: 'Approaching steady state', detail: `Accumulation stabilises after ≈ 4–5 half-lives. ${m.targetStatus !== 'n/a' ? `Predicted ${drug.therapeutic?.basis}: ${fmt(m.targetValue)} (${m.targetStatus} target).` : ''}`, tone: m.targetStatus === 'within' ? 'ok' : m.targetStatus === 'n/a' ? 'info' : 'warn' });
    for (const s of sideEffects.slice(0, 6)) {
      if (s.onsetH !== null) ev.push({ t: s.onsetH, title: `${ORGAN_LABEL[s.organ]}: ${s.name}`, detail: `${getDrug(s.drugId).name} — risk rises to ${(s.probability * 100).toFixed(0)}% (peak at ${fmtHours(s.peakH)}). Watch for: ${s.symptoms.slice(0, 2).join('; ').toLowerCase()}.`, tone: s.probability >= 0.5 ? 'danger' : 'warn' });
    }
    const met = (100 * journey.metabolised[last]) / jTotals.final;
    const exc = (100 * journey.excreted[last]) / jTotals.final;
    const path = drug.metabolism.map((x) => x.pathway).join(', ') || 'non-specific pathways';
    ev.push({ t: sim.durationH, title: `By ${fmtHours(sim.durationH)}: ${met.toFixed(0)}% metabolised, ${exc.toFixed(0)}% excreted`, detail: `Metabolism via ${path}; renal excretion depends on kidney function (CrCl ${Math.round(sim.physiology.crcl)} mL/min).`, tone: 'info' });
    return ev.sort((a, b) => a.t - b.t);
  }, [sim, journey, jTotals, focusId, regs, drug, sideEffects]);

  const policy = model?.policies?.[focusId];
  const rl = useMemo(() => (policy ? recommendFromPolicy(policy, patient, 'none') : null), [policy, patient]);

  const explain = async () => {
    if (!sim) return;
    setAiBusy(true);
    try {
      const m = sim.metrics[focusId];
      const last = journey ? journey.gut.length - 1 : 0;
      const context = JSON.stringify({
        patient: { age: patient.age, sex: patient.sex, weightKg: patient.weightKg, crcl: Math.round(sim.physiology.crcl), egfr: Math.round(sim.physiology.egfr), hepaticFunction: patient.childPugh, phenotypes: patient.phenotypes, conditions: patient.conditions.map((c) => c.name).slice(0, 8), pregnant: patient.pregnant },
        regimens: regs.map((r) => ({ drug: getDrug(r.drugId).name, dose: `${r.dose} ${r.unit}`, route: r.route, everyH: r.intervalH, doses: r.doses })),
        focusDrug: drug.name,
        metrics: { cmax: `${fmt(m.cmax)} ${m.unit}`, tmaxH: fmt(m.tmax), halfLifeH: fmt(m.halfLifeH), target: drug.therapeutic ? `${drug.therapeutic.basis} ${drug.therapeutic.low}-${drug.therapeutic.high}` : null, predicted: m.targetValue !== null ? fmt(m.targetValue) : null, status: m.targetStatus },
        journeyAtEnd: journey && jTotals ? Object.fromEntries(COMPARTMENTS.map((c) => [c, `${((100 * journey[c][last]) / jTotals.final).toFixed(0)}%`])) : null,
        sideEffects: sideEffects.slice(0, 6).map((s) => ({ drug: getDrug(s.drugId).name, organ: s.organ, effect: s.name, probability: `${(s.probability * 100).toFixed(0)}%`, onsetH: s.onsetH !== null ? Math.round(s.onsetH) : null, drivers: s.drivers.slice(0, 3).map((d) => d.feature) })),
        alerts: alerts.slice(0, 6).map((a) => ({ severity: a.severity, title: a.title, action: a.action })),
        rlSuggestion: rl ? { multiplierOfStandardDose: rl.best.multiplier, confidence: rl.confidence } : null,
        learnedFromOutcomes: model?.outcomes ?? 0,
      });
      setAi(await post<{ text: string; model: string }>('/ai/explain', { context }));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setAiBusy(false);
    }
  };

  const nowConc = sim?.series[focusId]?.conc[ci] ?? 0;
  const nowEff = sim?.series[focusId]?.effect?.[ci];
  const qtc = sim?.qtc[ci] ?? 0;
  const learnedN = model?.outcomes ?? 0;

  return (
    <div>
      <PageHeader
        icon={<HeartPulse className="size-5" />}
        title="Body digital twin"
        description="Give a medicine to the virtual patient and watch it travel through the body — absorption, first-pass, circulation, tissue distribution, metabolism and excretion — with organ effects and side effects predicted over time."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={<ClipboardPlus className="size-4" />} onClick={() => setOutcomeOpen(true)} disabled={!sim}>Record real outcome</Button>
            <Link to="/app/learning" className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-surface-2"><BrainCircuit className="size-4" aria-hidden />Learning lab</Link>
          </div>
        }
      />
      <div className="grid gap-6 2xl:grid-cols-[340px_1fr_380px] xl:grid-cols-[340px_1fr]">
        {/* Controls */}
        <div className="flex flex-col gap-4">
          <Card title="Patient twin">
            <div className="flex flex-col gap-3">
              <Field label="Twin" htmlFor="tw"><TwinPicker id="tw" twins={twins} value={twinId} onChange={setTwinId} /></Field>
              {patient.medicationHistory.length > 0 && <Switch checked={includeHistory} onChange={setIncludeHistory} label="Include past medicines" description="Residual drug and enzyme effects carry over." />}
              <Switch checked={useLearned} onChange={setUseLearned} label="Use learned model" description={learnedN ? `Personalised by ${learnedN} recorded outcome${learnedN > 1 ? 's' : ''}.` : 'No outcomes recorded yet — using population priors.'} />
            </div>
          </Card>
          <Card title="Medicines to give">
            <RegimenEditor regimens={regimens} onChange={(r) => { setRegimens(r); if (r.length && !r.some((x) => x.drugId === focus)) setFocus(r[0].drugId); }} colors={colors} />
            {ids.length > 1 && (
              <Field label="Show journey of" htmlFor="focus">
                <Select id="focus" value={focusId} onChange={(e) => setFocus(e.target.value)}>
                  {ids.map((id) => <option key={id} value={id}>{getDrug(id).name}</option>)}
                </Select>
              </Field>
            )}
          </Card>
          {rl && (
            <Card title={<span className="flex items-center gap-2"><Wand2 className="size-4" aria-hidden />RL dosing agent</span>} subtitle={`${policy!.episodes} simulated + ${policy!.realUpdates} real episodes`}>
              <p className="text-sm">For this patient context ({rl.state.renal}, {rl.state.age}, {rl.state.pgx}) the learned policy suggests <strong>{rl.best.multiplier}× the standard dose</strong>.</p>
              <div className="mt-2 flex items-center gap-2"><Badge tone={rl.confidence === 'high' ? 'ok' : rl.confidence === 'medium' ? 'warn' : 'neutral'}>{rl.confidence} confidence</Badge></div>
              <Button size="sm" className="mt-3" onClick={() => {
                const base = getDrug(focusId).defaultRegimen;
                setRegimens(regimens.map((r) => (r.drugId === focusId ? { ...r, dose: Number((base.dose * rl.best.multiplier).toPrecision(3)), unit: base.unit } : r)));
                toast(`Applied ${rl.best.multiplier}× standard dose`);
              }}>Apply suggestion</Button>
            </Card>
          )}
        </div>

        {/* 3D twin */}
        <div className="flex min-w-0 flex-col gap-4">
          {!sim || !frame ? (
            <Callout tone="info" title="Choose a medicine">Add a medicine on the left to see its journey through the body.</Callout>
          ) : (
            <>
              <div className="relative">
                {webgl ? (
                  <BodyTwin3D frame={frame} drugColor={colors(focusId)} highlight={hoverOrgan} onHoverOrgan={setHoverOrgan} autoRotate={rotate && !playing} />
                ) : (
                  <Card><BodyMap organs={Object.fromEntries(ORGANS.map((o) => [o, { ...frame.organs[o], notes: [] }])) as never} /></Card>
                )}
                {webgl && (
                  <>
                    <div className="pointer-events-none absolute left-4 top-4 rounded-xl bg-black/45 px-3 py-2 text-white backdrop-blur" aria-live="off">
                      <p className="text-[11px] uppercase tracking-wider text-white/60">Elapsed</p>
                      <p className="text-xl font-semibold tabular">Day {Math.floor(cursor / 24) + 1} · {String(Math.floor(cursor % 24)).padStart(2, '0')}:{String(Math.floor((cursor * 60) % 60)).padStart(2, '0')}</p>
                    </div>
                    <div className="pointer-events-none absolute right-4 top-4 grid grid-cols-2 gap-2 text-white">
                      {[
                        [drug.name.split(' ')[0], `${fmt(nowConc)} ${drug.display.unit}`],
                        ['Heart rate', `${Math.round(frame.heartRate)} bpm`],
                        ['QTc', `${Math.round(qtc)} ms`],
                        [drug.pd?.effect.split(' ')[0] ?? 'Effect', nowEff !== undefined ? `${fmt(nowEff)} ${drug.pd?.unit ?? ''}` : '—'],
                      ].map(([k, val]) => (
                        <div key={k} className="rounded-xl bg-black/45 px-3 py-1.5 backdrop-blur"><p className="text-[10px] uppercase tracking-wider text-white/60">{k}</p><p className="text-sm font-semibold tabular">{val}</p></div>
                      ))}
                    </div>
                    <div className="absolute inset-x-4 bottom-4 flex items-center gap-3 rounded-xl bg-black/50 px-3 py-2 text-white backdrop-blur">
                      <button onClick={() => { if (!playing && cursor >= sim.durationH) setCursor(0); setPlaying((p) => !p); }} className="grid size-9 place-items-center rounded-full bg-white text-[#0b1220]" aria-label={playing ? 'Pause' : 'Play the medicine journey'}>
                        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
                      </button>
                      <input type="range" aria-label="Time since first dose" min={0} max={sim.durationH} step={sim.durationH / 500} value={cursor} onChange={(e) => { setPlaying(false); setCursor(Number(e.target.value)); }} className="flex-1" />
                      <span className="w-20 text-right text-xs tabular text-white/80">{fmtHours(cursor)}</span>
                      <button onClick={() => setCursor(0)} className="rounded-md p-1.5 text-white/80 hover:bg-white/10" aria-label="Restart"><RotateCcw className="size-4" /></button>
                      <button onClick={() => setRotate((r) => !r)} className={cx('rounded-md p-1.5 hover:bg-white/10', rotate ? 'text-white' : 'text-white/50')} aria-pressed={rotate} aria-label="Auto-rotate"><Rotate3D className="size-4" /></button>
                    </div>
                  </>
                )}
              </div>
              {hoverOrgan && (
                <p className="text-sm text-fg-2" role="status">
                  <strong className="text-fg">{ORGAN_LABEL[hoverOrgan]}</strong> — engagement {Math.round(frame.organs[hoverOrgan].therapeutic * 100)}%, risk {Math.round(frame.organs[hoverOrgan].risk * 100)}%.{' '}
                  {sim.drugIds.flatMap((id) => getDrug(id).organs.filter((o) => o.organ === hoverOrgan).map((o) => `${getDrug(id).name}: ${o.note}`)).slice(0, 2).join(' · ')}
                </p>
              )}
              <Card title="Where the dose is now" subtitle={`${drug.name} — mass balance of the administered dose`}>
                <div className="flex h-4 overflow-hidden rounded-full bg-surface-3" role="img" aria-label="Dose distribution by compartment">
                  {COMPARTMENTS.map((c) => <span key={c} style={{ width: `${(frame.journey[c] * 100).toFixed(2)}%`, background: COMP_COLOR[c] }} className="h-full border-r-2 border-surface last:border-r-0" />)}
                </div>
                <ul className="mt-3 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                  {COMPARTMENTS.map((c) => (
                    <li key={c} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2"><span className="size-2.5 rounded-sm" style={{ background: COMP_COLOR[c] }} aria-hidden />{COMP_LABEL[c]}</span>
                      <span className="font-medium tabular">{(frame.journey[c] * 100).toFixed(0)}%</span>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card title={`${drug.name} concentration`} bodyClass="p-3">
                <TimeChart
                  ariaLabel={`${drug.name} concentration`}
                  t={sim.t}
                  unit={drug.display.unit}
                  height={190}
                  cursorH={cursor}
                  band={drug.therapeutic && drug.therapeutic.basis !== 'auc24' ? { ...drug.therapeutic, label: 'target' } : undefined}
                  toxic={drug.toxic && drug.toxic.basis !== 'auc24' ? { value: drug.toxic.value, label: 'toxic' } : undefined}
                  series={[{ def: { key: 'c', label: drug.name, color: colors(focusId) }, values: sim.series[focusId].conc }]}
                />
              </Card>
            </>
          )}
        </div>

        {/* Insight column */}
        <div className="flex flex-col gap-4 xl:col-span-2 2xl:col-span-1">
          <Card title="Predicted side effects" subtitle={useLearned && model && Object.values(model.ae.samples).some((n) => n > 0) ? 'Organ risk models refined by your recorded outcomes' : 'Mechanistic prior model (no outcomes recorded yet)'}>
            {sideEffects.length === 0 ? <p className="text-sm text-muted">No meaningful side-effect risk predicted.</p> : (
              <ul className="flex flex-col gap-2">
                {sideEffects.slice(0, 8).map((s) => {
                  const now = s.timeline[ci] ?? 0;
                  return (
                    <li key={s.id}>
                      <button
                        className={cx('w-full rounded-xl border p-3 text-left transition-colors', hoverOrgan === s.organ ? 'border-primary bg-primary-soft' : 'border-line hover:border-line-strong')}
                        onMouseEnter={() => setHoverOrgan(s.organ)}
                        onMouseLeave={() => setHoverOrgan(null)}
                        onFocus={() => setHoverOrgan(s.organ)}
                        onBlur={() => setHoverOrgan(null)}
                        onClick={() => s.onsetH !== null && setCursor(s.peakH)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold">{s.name}</p>
                            <p className="text-xs text-muted">{getDrug(s.drugId).name} · {ORGAN_LABEL[s.organ]}{s.learned && ' · learned'}</p>
                          </div>
                          <Badge tone={s.probability >= 0.5 ? 'danger' : s.probability >= 0.2 ? 'warn' : 'neutral'}>{(s.probability * 100).toFixed(0)}% peak</Badge>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded bg-surface-3" role="meter" aria-label="Risk now" aria-valuenow={Math.round(now * 100)} aria-valuemin={0} aria-valuemax={100}>
                          <div className={cx('h-full rounded', now >= 0.5 ? 'bg-danger' : now >= 0.2 ? 'bg-warn' : 'bg-ok')} style={{ width: `${now * 100}%` }} />
                        </div>
                        <p className="mt-1 text-[11px] text-muted">Now {(now * 100).toFixed(0)}% · {s.onsetH !== null ? `onset ≈ ${fmtHours(s.onsetH)}` : 'below alert level'}</p>
                        {s.drivers.length > 0 && <p className="mt-1 text-[11px] text-fg-2">Drivers: {s.drivers.slice(0, 3).map((d) => d.feature).join(', ')}</p>}
                        <p className="mt-1 text-[11px] text-fg-2">Symptoms: {s.symptoms.slice(0, 3).join(' · ')}</p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card title="What happens in the body" subtitle="Click an event to jump there">
            <ol className="relative ml-2 border-l border-line">
              {events.map((e, i) => (
                <li key={i} className="mb-3 ml-4">
                  <span className={cx('absolute -left-[5px] mt-1.5 size-2.5 rounded-full', e.tone === 'danger' ? 'bg-danger' : e.tone === 'warn' ? 'bg-warn' : e.tone === 'ok' ? 'bg-ok' : 'bg-primary', cursor >= e.t ? 'opacity-100' : 'opacity-40')} aria-hidden />
                  <button className="text-left" onClick={() => { setPlaying(false); setCursor(e.t); }}>
                    <p className="text-[11px] text-muted tabular">{fmtHours(e.t)}</p>
                    <p className={cx('text-sm font-medium', cursor >= e.t ? 'text-fg' : 'text-muted')}>{e.title}</p>
                    <p className="text-xs text-fg-2">{e.detail}</p>
                  </button>
                </li>
              ))}
            </ol>
          </Card>
          <Card title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-primary" aria-hidden />AI insight</span>} actions={aiEnabled ? <Button size="sm" variant="secondary" loading={aiBusy} onClick={explain} disabled={!sim}>{ai ? 'Regenerate' : 'Explain'}</Button> : undefined}>
            {ai ? (
              <>
                <RichText text={ai.text} />
                <p className="mt-3 text-[11px] text-muted">Generated by {ai.model}. Educational explanation — verify before acting.</p>
              </>
            ) : aiEnabled ? (
              <p className="text-sm text-muted">Ask the AI to explain this patient’s drug journey, side-effect risks and what would change the outcome, in plain language.</p>
            ) : (
              <div className="space-y-2 text-sm text-fg-2">
                {sim && <p>{drug.name} peaks at {fmt(sim.metrics[focusId].cmax)} {drug.display.unit} after {fmtHours(sim.metrics[focusId].tmax)}; the twin clears it with a half-life of {fmtHours(sim.metrics[focusId].halfLifeH)}.{sideEffects[0] ? ` Highest predicted risk: ${sideEffects[0].name.toLowerCase()} (${(sideEffects[0].probability * 100).toFixed(0)}%), driven by ${sideEffects[0].drivers.slice(0, 2).map((d) => d.feature).join(' and ') || 'exposure'}.` : ''}</p>}
                <p className="text-xs text-muted">Natural-language AI explanations are available when the server administrator sets <code>ANTHROPIC_API_KEY</code>.</p>
              </div>
            )}
          </Card>
        </div>
      </div>
      {sim && outcomeOpen && (
        <OutcomeModal
          onClose={() => setOutcomeOpen(false)}
          patient={patient}
          twinId={twinId || undefined}
          regimens={regs}
          drugId={focusId}
          predicted={sideEffects.filter((s) => s.drugId === focusId)}
          onSaved={(learned) => {
            void loadModel();
            toast(learned);
          }}
        />
      )}
    </div>
  );
}

function OutcomeModal({ onClose, patient, twinId, regimens, drugId, predicted, onSaved }: {
  onClose: () => void; patient: Patient; twinId?: string; regimens: Regimen[]; drugId: string; predicted: SideEffectPrediction[]; onSaved: (msg: string) => void;
}) {
  const toast = useToast();
  const d = getDrug(drugId);
  const organs = Array.from(new Set([...d.organs.filter((o) => o.kind === 'adverse').map((o) => o.organ), ...predicted.map((p) => p.organ)]));
  const [levels, setLevels] = useState<{ id: string; timeH: number; value: number }[]>([]);
  const [effects, setEffects] = useState<Record<string, { occurred: boolean; severity: 'mild' | 'moderate' | 'severe' }>>(Object.fromEntries(organs.map((o) => [o, { occurred: false, severity: 'moderate' }])));
  const [prevStatus, setPrevStatus] = useState<RLStatus>('none');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const reg = regimens.find((r) => r.drugId === drugId)!;
  const dur = reg.startH + reg.doses * reg.intervalH;
  const save = async () => {
    setBusy(true);
    try {
      const base = d.defaultRegimen;
      const r = await post<{ learned: { pk?: { clFactor: number }; sideEffects?: { positives: string[] }; policy?: { observed: string } } }>('/outcomes', {
        twinId,
        patient,
        drugId,
        regimens,
        observations: levels.map(({ timeH, value }) => ({ timeH, value })),
        sideEffects: organs.map((o) => ({ organ: o, occurred: effects[o].occurred, severity: effects[o].occurred ? effects[o].severity : undefined })),
        decision: { prevStatus, multiplier: reg.unit === base.unit ? reg.dose / base.dose : 1 },
        notes: notes || undefined,
      });
      const parts: string[] = [];
      if (r.learned.pk) parts.push(`clearance ×${r.learned.pk.clFactor.toFixed(2)} learned`);
      if (r.learned.sideEffects) parts.push('side-effect model updated');
      if (r.learned.policy) parts.push(`RL policy reinforced (${r.learned.policy.observed})`);
      onSaved(`Outcome recorded — ${parts.join(', ') || 'stored'}.`);
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Record observed outcome — ${d.name}`} wide footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save} icon={<BrainCircuit className="size-4" />}>Save & learn</Button></>}>
      <div className="flex flex-col gap-5">
        <Callout tone="info">What actually happened to the patient? Measured levels refine the clearance prior for future patients (Bayesian pooling), observed side effects train the organ risk models, and the dose decision reinforces the RL dosing agent. Use de-identified data only.</Callout>
        <div>
          <p className="mb-2 text-sm font-semibold">Measured drug levels <span className="font-normal text-muted">(optional, {d.display.unit}, hours after first dose)</span></p>
          {levels.map((l, i) => (
            <div key={l.id} className="mb-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              <NumberField label={`Level ${i + 1} time`} value={l.timeH} min={0.1} max={dur + 48} unit="h" onChange={(v) => setLevels(levels.map((x) => (x.id === l.id ? { ...x, timeH: v } : x)))} />
              <NumberField label="Value" value={l.value} min={0} max={1e5} unit={d.display.unit} onChange={(v) => setLevels(levels.map((x) => (x.id === l.id ? { ...x, value: v } : x)))} />
              <button className="mb-2 rounded-md p-2 text-muted hover:text-danger" aria-label={`Remove level ${i + 1}`} onClick={() => setLevels(levels.filter((x) => x.id !== l.id))}><Trash2 className="size-4" /></button>
            </div>
          ))}
          <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} disabled={levels.length >= 8 || !!d.pk.mm} onClick={() => setLevels([...levels, { id: uid('l'), timeH: Math.max(1, Math.round(dur - reg.intervalH * 0.1)), value: d.therapeutic && d.therapeutic.basis !== 'auc24' ? d.therapeutic.low : 10 }])}>Add level</Button>
        </div>
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Observed side effects</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {organs.map((o) => {
              const p = predicted.find((x) => x.organ === o);
              return (
                <div key={o} className={cx('rounded-xl border p-3', effects[o].occurred ? 'border-danger bg-danger-soft/40' : 'border-line')}>
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input type="checkbox" className="size-4 accent-[var(--danger)]" checked={effects[o].occurred} onChange={(e) => setEffects({ ...effects, [o]: { ...effects[o], occurred: e.target.checked } })} />
                    {ORGAN_LABEL[o]}{p ? ` — ${p.name}` : ''}
                  </label>
                  {p && <p className="ml-6 text-xs text-muted">Predicted {(p.probability * 100).toFixed(0)}%</p>}
                  {effects[o].occurred && (
                    <Select aria-label={`${ORGAN_LABEL[o]} severity`} className="mt-2 h-8 text-xs" value={effects[o].severity} onChange={(e) => setEffects({ ...effects, [o]: { ...effects[o], severity: e.target.value as 'mild' } })}>
                      <option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option>
                    </Select>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Exposure status before this dose decision" htmlFor="ps" info="RL state: what the last level showed when the dose was chosen ('none' for a starting dose).">
            <Select id="ps" value={prevStatus} onChange={(e) => setPrevStatus(e.target.value as RLStatus)}>
              {RL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Notes" htmlFor="on"><textarea id="on" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} className="h-10 min-h-10 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm" /></Field>
        </div>
        <p className="flex items-center gap-2 text-xs text-muted"><Activity className="size-3.5" aria-hidden />Dose given: {reg.dose} {reg.unit} q{reg.intervalH}h ({(reg.unit === d.defaultRegimen.unit ? reg.dose / d.defaultRegimen.dose : 1).toFixed(2)}× standard)</p>
      </div>
    </Modal>
  );
}
