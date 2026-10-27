import { useEffect, useMemo, useRef, useState } from 'react';
import { Syringe, Play, Pause, RotateCcw, FastForward, Droplets, ArrowUpCircle, Trophy } from 'lucide-react';
import {
  marsh, minto, predictBIS, predictHR, predictMAP, probNoResponseLaryngoscopy, schnider, scoreOR, SURGICAL_SCENARIOS, tciStep,
  type CompState, type ORScore, type ORSnapshot, type SurgicalScenario,
} from '@medcare/engine';
import { post } from '../lib/api';
import { useToast } from '../lib/toast';
import { fmt } from '../lib/format';
import { Badge, Button, Callout, Card, Field, PageHeader, Select, cx } from '../components/ui';
import { TimeChart } from '../components/charts';

const DT_MIN = 1 / 6; // 10-second control interval
const zero: CompState = { a1: 0, a2: 0, a3: 0, ce: 0 };

interface Engine {
  minute: number;
  prop: CompState;
  remi: CompState;
  fluidsMl: number;
  pressorAt: number | null;
  snaps: ORSnapshot[];
}

function Vital({ label, value, unit, tone, sub }: { label: string; value: string; unit?: string; tone?: 'ok' | 'warn' | 'danger'; sub?: string }) {
  return (
    <div className="rounded-xl bg-[#0b1220] p-3 text-white">
      <p className="text-[11px] uppercase tracking-wider text-white/60">{label}</p>
      <p className={cx('text-2xl font-semibold tabular', tone === 'ok' && 'text-[#5ee0b5]', tone === 'warn' && 'text-[#f5c451]', tone === 'danger' && 'text-[#ff8a80]')}>
        {value}
        {unit && <span className="ml-1 text-xs font-normal text-white/60">{unit}</span>}
      </p>
      {sub && <p className="text-[11px] text-white/60">{sub}</p>}
    </div>
  );
}

export default function Anesthesia() {
  const toast = useToast();
  const [scenarioId, setScenarioId] = useState(SURGICAL_SCENARIOS[0].id);
  const scenario = SURGICAL_SCENARIOS.find((s) => s.id === scenarioId) as SurgicalScenario;
  const [model, setModel] = useState<'marsh' | 'schnider'>('schnider');
  const [mode, setMode] = useState<'effect' | 'plasma'>('effect');
  const [propTarget, setPropTarget] = useState(0);
  const [remiTarget, setRemiTarget] = useState(0);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(30);
  const [, force] = useState(0);
  const [score, setScore] = useState<ORScore | null>(null);
  const eng = useRef<Engine>({ minute: 0, prop: zero, remi: zero, fluidsMl: 0, pressorAt: null, snaps: [] });
  const targets = useRef({ prop: 0, remi: 0 });
  targets.current = { prop: propTarget, remi: remiTarget };

  const pt = scenario.patient;
  const kProp = useMemo(() => (model === 'marsh' ? marsh(pt) : schnider(pt)), [model, pt]);
  const kRemi = useMemo(() => minto(pt), [pt]);
  const bloodVolume = pt.weightKg * 70;

  const reset = () => {
    setRunning(false);
    eng.current = { minute: 0, prop: zero, remi: zero, fluidsMl: 0, pressorAt: null, snaps: [] };
    setPropTarget(0);
    setRemiTarget(0);
    setScore(null);
    force((x) => x + 1);
  };
  useEffect(reset, [scenarioId, model]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = () => {
    const e = eng.current;
    if (e.minute >= scenario.durationMin) return false;
    const p = tciStep(e.prop, kProp, targets.current.prop, mode, 200, DT_MIN);
    const r = tciStep(e.remi, kRemi, targets.current.remi, mode, 1000, DT_MIN);
    e.prop = p.state;
    e.remi = r.state;
    e.minute += DT_MIN;
    const past = scenario.events.filter((ev) => ev.minute <= e.minute);
    const last = past[past.length - 1];
    let stimulus = last?.stimulus ?? 0;
    if (last && last.stimulus >= 0.9) stimulus = 0.3 + (last.stimulus - 0.3) * Math.exp(-(e.minute - last.minute) / 2);
    const lost = past.reduce((s, ev) => s + (ev.bloodLossMl ?? 0), 0);
    const lossFrac = Math.max(0, lost - e.fluidsMl * 0.5) / bloodVolume;
    const sens = pt.sensitivity;
    let map = predictMAP(pt.baselineMAP, p.ce * sens, r.ce, stimulus, lossFrac);
    if (e.pressorAt !== null) map *= 1 + 0.2 * Math.exp(-(e.minute - e.pressorAt) / 5);
    const snap: ORSnapshot = {
      minute: e.minute,
      cpProp: p.cp,
      ceProp: p.ce,
      cpRemi: r.cp,
      ceRemi: r.ce,
      rateProp: p.rate * 60,
      rateRemi: r.rate,
      bis: predictBIS(p.ce, r.ce, sens) + stimulus * 8 * (1 - probNoResponseLaryngoscopy(p.ce, r.ce)),
      map,
      hr: predictHR(pt.baselineHR, r.ce, stimulus, lossFrac, p.ce),
      pNoResponse: probNoResponseLaryngoscopy(p.ce * sens, r.ce * sens),
      stimulus,
      bloodLossMl: lost,
      event: scenario.events.find((ev) => Math.abs(ev.minute - e.minute) < DT_MIN / 2)?.label,
    };
    e.snaps.push(snap);
    return true;
  };

  useEffect(() => {
    if (!running) return;
    let acc = 0;
    const id = setInterval(() => {
      acc += (speed * 0.1) / 60; // simulated minutes per tick
      let n = 0;
      while (acc >= DT_MIN && n < 200) {
        acc -= DT_MIN;
        n++;
        if (!step()) {
          setRunning(false);
          setScore(scoreOR(eng.current.snaps, scenario));
          break;
        }
      }
      force((x) => x + 1);
    }, 100);
    return () => clearInterval(id);
  }, [running, speed, kProp, kRemi, mode, scenario]); // eslint-disable-line react-hooks/exhaustive-deps

  const skipToNext = () => {
    const nextEv = scenario.events.find((ev) => ev.minute > eng.current.minute + 0.01);
    const until = nextEv ? nextEv.minute : scenario.durationMin;
    while (eng.current.minute < until - 1e-6 && step());
    if (eng.current.minute >= scenario.durationMin) setScore(scoreOR(eng.current.snaps, scenario));
    force((x) => x + 1);
  };

  const snaps = eng.current.snaps;
  const now = snaps[snaps.length - 1];
  const minute = eng.current.minute;
  const upcoming = scenario.events.filter((ev) => ev.minute > minute).slice(0, 2);
  const t = snaps.map((s) => s.minute / 60);
  const finished = minute >= scenario.durationMin - 1e-6;

  return (
    <div>
      <PageHeader
        icon={<Syringe className="size-5" />}
        title="Operating room & anaesthesia simulator"
        description="Target-controlled infusion of propofol (Marsh / Schnider) and remifentanil (Minto) with effect-site modelling, BIS depth of hypnosis (Bouillon response surface), haemodynamics and surgical stimulation."
      />
      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <div className="flex flex-col gap-4">
          <Card title="Scenario">
            <div className="flex flex-col gap-3">
              <Field label="Case" htmlFor="sc">
                <Select id="sc" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
                  {SURGICAL_SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                </Select>
              </Field>
              <p className="text-sm text-fg-2">{scenario.summary}</p>
              <p className="text-xs text-muted">{pt.age} y {pt.sex}, {pt.weightKg} kg, {pt.heightCm} cm · ASA {pt.asa} · {pt.history}</p>
              <div>
                <p className="mb-1 text-xs font-medium text-fg-2">Objectives</p>
                <ul className="list-disc space-y-0.5 pl-4 text-xs text-fg-2">{scenario.objectives.map((o) => <li key={o}>{o}</li>)}</ul>
              </div>
            </div>
          </Card>
          <Card title="Pump settings">
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Propofol model" htmlFor="pm">
                  <Select id="pm" value={model} onChange={(e) => setModel(e.target.value as 'marsh' | 'schnider')} disabled={snaps.length > 0}>
                    <option value="schnider">Schnider</option>
                    <option value="marsh">Marsh</option>
                  </Select>
                </Field>
                <Field label="Targeting" htmlFor="tm">
                  <Select id="tm" value={mode} onChange={(e) => setMode(e.target.value as 'effect' | 'plasma')}>
                    <option value="effect">Effect-site</option>
                    <option value="plasma">Plasma</option>
                  </Select>
                </Field>
              </div>
              <div>
                <label htmlFor="pt" className="flex justify-between text-sm"><span>Propofol target</span><span className="font-semibold tabular">{propTarget.toFixed(1)} µg/mL</span></label>
                <input id="pt" type="range" min={0} max={8} step={0.1} value={propTarget} onChange={(e) => setPropTarget(Number(e.target.value))} className="w-full" />
              </div>
              <div>
                <label htmlFor="rt" className="flex justify-between text-sm"><span>Remifentanil target</span><span className="font-semibold tabular">{remiTarget.toFixed(1)} ng/mL</span></label>
                <input id="rt" type="range" min={0} max={10} step={0.5} value={remiTarget} onChange={(e) => setRemiTarget(Number(e.target.value))} className="w-full" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" size="sm" icon={<Droplets className="size-3.5" />} disabled={finished} onClick={() => { eng.current.fluidsMl += 500; toast('500 mL crystalloid bolus given', 'info'); }}>Fluid 500 mL</Button>
                <Button variant="secondary" size="sm" icon={<ArrowUpCircle className="size-3.5" />} disabled={finished} onClick={() => { eng.current.pressorAt = eng.current.minute; toast('Phenylephrine 100 µg given', 'info'); }}>Vasopressor</Button>
              </div>
            </div>
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={running ? <Pause className="size-4" /> : <Play className="size-4" />} onClick={() => setRunning((r) => !r)} disabled={finished}>{running ? 'Pause' : snaps.length ? 'Resume' : 'Start case'}</Button>
            <Button variant="secondary" icon={<FastForward className="size-4" />} onClick={skipToNext} disabled={running || finished}>Next event</Button>
            <Button variant="secondary" icon={<RotateCcw className="size-4" />} onClick={reset}>Reset</Button>
            <Select aria-label="Simulation speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="w-28">
              {[10, 30, 60, 120].map((s) => <option key={s} value={s}>{s}× speed</option>)}
            </Select>
            <span className="ml-auto text-sm tabular text-muted">{Math.floor(minute)}:{String(Math.round((minute % 1) * 60)).padStart(2, '0')} / {scenario.durationMin}:00</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-live="off">
            <Vital label="BIS" value={now ? fmt(now.bis) : '97'} tone={!now ? undefined : now.bis < 40 ? 'warn' : now.bis <= 60 ? 'ok' : now.bis > 70 && minute > 5 ? 'danger' : undefined} sub="target 40–60" />
            <Vital label="MAP" value={now ? fmt(now.map) : String(pt.baselineMAP)} unit="mmHg" tone={now && now.map < 65 ? 'danger' : 'ok'} />
            <Vital label="HR" value={now ? fmt(now.hr) : String(pt.baselineHR)} unit="bpm" tone={now && (now.hr < 45 || now.hr > 120) ? 'warn' : undefined} />
            <Vital label="Ce propofol" value={now ? now.ceProp.toFixed(2) : '0.00'} unit="µg/mL" sub={now ? `Cp ${now.cpProp.toFixed(2)} · ${fmt(now.rateProp)} mg/h` : ''} />
            <Vital label="Ce remi" value={now ? now.ceRemi.toFixed(2) : '0.00'} unit="ng/mL" sub={now ? `${(now.rateRemi / pt.weightKg).toFixed(2)} µg/kg/min` : ''} />
            <Vital label="P(no response)" value={now ? `${(now.pNoResponse * 100).toFixed(0)}%` : '0%'} sub="to laryngoscopy" tone={now && now.pNoResponse >= 0.9 ? 'ok' : 'warn'} />
          </div>
          <Card title="Case timeline" bodyClass="p-4">
            <ol className="flex flex-wrap gap-2">
              {scenario.events.map((ev) => {
                const done = ev.minute <= minute;
                return (
                  <li key={ev.label} className={cx('rounded-lg border px-2.5 py-1.5 text-xs', done ? 'border-line bg-surface-2 text-muted' : upcoming[0] === ev ? 'border-primary bg-primary-soft text-primary' : 'border-line')}>
                    <span className="font-semibold tabular">{ev.minute}′</span> {ev.label}
                  </li>
                );
              })}
            </ol>
            {upcoming[0] && <p className="mt-2 text-sm text-fg-2"><span className="font-medium">Next ({upcoming[0].minute}′): </span>{upcoming[0].description}</p>}
          </Card>
          {snaps.length > 1 ? (
            <div className="grid gap-4 2xl:grid-cols-2">
              <Card title="Depth of hypnosis (BIS)" bodyClass="p-3">
                <TimeChart ariaLabel="BIS over time" t={t} unit="BIS" height={200} yDomain={[0, 100]} band={{ low: 40, high: 60, label: 'target' }} series={[{ def: { key: 'bis', label: 'BIS', color: 'var(--s7)' }, values: snaps.map((s) => s.bis) }]} />
              </Card>
              <Card title="Mean arterial pressure" bodyClass="p-3">
                <TimeChart ariaLabel="MAP over time" t={t} unit="mmHg" height={200} yDomain={[30, 'auto']} refLines={[{ y: 65, label: '65 mmHg' }]} series={[{ def: { key: 'map', label: 'MAP', color: 'var(--s8)' }, values: snaps.map((s) => s.map) }]} />
              </Card>
              <Card title="Propofol concentrations" bodyClass="p-3">
                <TimeChart ariaLabel="Propofol concentrations" t={t} unit="µg/mL" height={200} series={[{ def: { key: 'cp', label: 'Plasma', color: 'var(--s1)', dash: '4 3' }, values: snaps.map((s) => s.cpProp) }, { def: { key: 'ce', label: 'Effect-site', color: 'var(--s1)' }, values: snaps.map((s) => s.ceProp) }]} />
              </Card>
              <Card title="Remifentanil concentrations" bodyClass="p-3">
                <TimeChart ariaLabel="Remifentanil concentrations" t={t} unit="ng/mL" height={200} series={[{ def: { key: 'cp', label: 'Plasma', color: 'var(--s2)', dash: '4 3' }, values: snaps.map((s) => s.cpRemi) }, { def: { key: 'ce', label: 'Effect-site', color: 'var(--s2)' }, values: snaps.map((s) => s.ceRemi) }]} />
              </Card>
            </div>
          ) : (
            <Callout tone="info" title="Getting started">Set a propofol effect-site target (typically 3–5 µg/mL for induction in healthy adults, lower in elderly) and a remifentanil target (2–6 ng/mL) before laryngoscopy, then start the case. Watch the delay between plasma and effect-site concentrations.</Callout>
          )}
          {score && (
            <Card title="Case debrief" actions={<Button size="sm" variant="secondary" onClick={() => post('/simulations', { name: `${scenario.title} — score ${score.score}`, kind: 'anesthesia', config: { scenarioId, model, mode }, summary: { ...score } }).then(() => toast('Debrief saved')).catch((e) => toast(e.message, 'error'))}>Save</Button>}>
              <div className="flex flex-wrap items-center gap-6">
                <div className="flex items-center gap-3">
                  <Trophy className={cx('size-10', score.score >= 80 ? 'text-ok' : score.score >= 60 ? 'text-warn' : 'text-danger')} aria-hidden />
                  <div><p className="text-3xl font-semibold tabular">{score.score}</p><p className="text-xs text-muted">out of 100</p></div>
                </div>
                <div className="grid flex-1 grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <div><p className="text-xs text-muted">BIS in range</p><p className="font-semibold tabular">{score.pctBisInRange.toFixed(0)}%</p></div>
                  <div><p className="text-xs text-muted">Hypotension</p><p className="font-semibold tabular">{score.minutesHypotension.toFixed(1)} min</p></div>
                  <div><p className="text-xs text-muted">Propofol used</p><p className="font-semibold tabular">{fmt(score.propofolTotalMg)} mg</p></div>
                  <div><p className="text-xs text-muted">Remifentanil used</p><p className="font-semibold tabular">{fmt(score.remiTotalUg)} µg</p></div>
                </div>
              </div>
              <ul className="mt-4 space-y-1 text-sm text-fg-2">{score.feedback.map((f) => <li key={f} className="flex gap-2"><Badge tone="info">tip</Badge>{f}</li>)}</ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
