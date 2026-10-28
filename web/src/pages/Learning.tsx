import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrainCircuit, Play, Save, Trash2, RefreshCcw } from 'lucide-react';
import {
  AE_FEATURES, AE_PRIOR_WEIGHTS, defaultPatient, describeState, getDrug, ORGANS, RL_ACTIONS, RL_ELIGIBLE, RL_STATUSES, stateIndex,
  type DosingPolicy, type LearnedModel, type RLStatus,
} from '@medcare/engine';
import { del, get, put } from '../lib/api';
import { useToast } from '../lib/toast';
import { fmt, relativeTime } from '../lib/format';
import { Badge, Button, Callout, Card, ConfirmDialog, Field, NumberField, PageHeader, Select, Stat, Tabs, cx } from '../components/ui';
import { TimeChart } from '../components/charts';
import { ORGAN_LABEL } from '../components/BodyMap';

interface PriorSummary { n: number; clFactor: number; vFactor: number; sdCL: number; weight: number }
interface OutcomeRow { id: string; drugId: string; sideEffects: { organ: string; occurred: boolean }[]; observations: unknown[]; learned: Record<string, unknown>; createdAt: number }

function PolicyMap({ policy }: { policy: DosingPolicy }) {
  // Recommended multiplier by renal band × last exposure status, for a typical 70 kg, 40–64 y, normal-activity patient.
  const renal = [{ label: 'CrCl < 30', scr: 3.0 }, { label: 'CrCl 30–59', scr: 1.6 }, { label: 'CrCl 60–89', scr: 1.1 }, { label: 'CrCl ≥ 90', scr: 0.8 }];
  const A = RL_ACTIONS.length;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] border-separate border-spacing-1 text-xs">
        <thead>
          <tr><th className="text-left font-medium text-muted">Kidney function ↓ / last level →</th>{RL_STATUSES.map((s) => <th key={s} className="font-medium text-muted">{s === 'none' ? 'start' : s}</th>)}</tr>
        </thead>
        <tbody>
          {renal.map((r) => (
            <tr key={r.label}>
              <th scope="row" className="pr-2 text-left font-medium">{r.label}</th>
              {RL_STATUSES.map((st) => {
                const s = stateIndex(policy.drugId, defaultPatient({ age: 55, scr: r.scr }), st as RLStatus);
                let best = 0;
                for (let a = 1; a < A; a++) if (policy.q[s * A + a] > policy.q[s * A + best]) best = a;
                const m = RL_ACTIONS[best];
                const visits = policy.counts.slice(s * A, s * A + A).reduce((x, y) => x + y, 0);
                return (
                  <td key={st} title={`${describeState(s).renal}, last ${st}: ${visits} visits`} className={cx('h-10 rounded-md text-center font-semibold', m < 1 ? 'bg-info-soft text-info' : m > 1 ? 'bg-warn-soft text-warn' : 'bg-surface-2', visits < 5 && 'opacity-50')}>
                    {m}×
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-muted">Cells show the greedy dose multiplier (× standard). Faded cells have few visits (low confidence). Blue = reduce, amber = increase.</p>
    </div>
  );
}

export default function Learning() {
  const toast = useToast();
  const [model, setModel] = useState<LearnedModel | null>(null);
  const [priors, setPriors] = useState<Record<string, PriorSummary>>({});
  const [outcomes, setOutcomes] = useState<OutcomeRow[]>([]);
  const [tab, setTab] = useState<'rl' | 'pk' | 'ae' | 'outcomes'>('rl');
  const [drugId, setDrugId] = useState('vancomycin');
  const [episodes, setEpisodes] = useState(1500);
  const [progress, setProgress] = useState<number | null>(null);
  const [curve, setCurve] = useState<number[]>([]);
  const [trained, setTrained] = useState<DosingPolicy | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const worker = useRef<Worker | null>(null);

  const load = useCallback(() => {
    get<{ model: LearnedModel; priors: Record<string, PriorSummary> }>('/learning/model').then((r) => { setModel(r.model); setPriors(r.priors); }).catch((e) => toast(e.message, 'error'));
    get<{ outcomes: OutcomeRow[] }>('/outcomes').then((r) => setOutcomes(r.outcomes)).catch(() => undefined);
  }, [toast]);
  useEffect(() => {
    load();
    return () => worker.current?.terminate();
  }, [load]);

  const saved = model?.policies?.[drugId] ?? null;
  const shown = trained?.drugId === drugId ? trained : saved;

  const train = () => {
    worker.current?.terminate();
    const w = new Worker(new URL('../workers/rl.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    setProgress(0);
    setCurve(saved?.rewardCurve ?? []);
    setTrained(null);
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        setProgress(m.fraction);
        setCurve((c) => [...c, m.meanReward]);
      } else if (m.type === 'evaluating') setProgress(1);
      else if (m.type === 'done') {
        setTrained(m.policy);
        setProgress(null);
        w.terminate();
      } else if (m.type === 'error') {
        toast(m.message, 'error');
        setProgress(null);
      }
    };
    w.postMessage({ drugId, episodes, start: saved, seed: Math.floor(Math.random() * 1e6) });
  };

  const savePolicy = async () => {
    if (!trained) return;
    try {
      await put(`/learning/policies/${drugId}`, trained);
      toast('Policy saved — the body twin and simulator will now use it');
      setTrained(null);
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const aeRows = useMemo(() => (model ? ORGANS.map((o) => ({ organ: o, n: model.ae.samples[o], w: model.ae.weights[o] })) : []), [model]);
  const curveT = (shown?.rewardCurve.length ? shown.rewardCurve : curve).map((_, i) => (i + 1) * 25);
  const curveV = shown?.rewardCurve.length ? shown.rewardCurve : curve;

  return (
    <div>
      <PageHeader
        icon={<BrainCircuit className="size-5" />}
        title="AI learning lab"
        description="The twin learns in three ways: a reinforcement-learning dosing agent trained on virtual patients and reinforced by real outcomes; Bayesian pooling of measured levels that personalises population pharmacokinetics; and organ side-effect models updated from observed adverse events."
        actions={<Button variant="secondary" icon={<Trash2 className="size-4" />} onClick={() => setResetOpen(true)}>Reset learned model</Button>}
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Recorded outcomes" value={model?.outcomes ?? '—'} />
        <Stat label="Drugs with learned PK" value={Object.keys(priors).length} />
        <Stat label="Side-effect training samples" value={model ? Object.values(model.ae.samples).reduce((a, b) => a + b, 0) : '—'} />
        <Stat label="Trained dosing policies" value={model ? Object.keys(model.policies).length : '—'} />
      </div>
      <div className="mb-4">
        <Tabs label="Learning sections" value={tab} onChange={setTab} tabs={[{ id: 'rl', label: 'RL dosing agent' }, { id: 'pk', label: 'Learned pharmacokinetics' }, { id: 'ae', label: 'Side-effect models' }, { id: 'outcomes', label: `Outcome registry (${outcomes.length})` }]} />
      </div>

      {tab === 'rl' && (
        <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
          <Card title="Train in silico">
            <div className="flex flex-col gap-3">
              <Field label="Medicine" htmlFor="rld">
                <Select id="rld" value={drugId} onChange={(e) => { setDrugId(e.target.value); setCurve([]); setTrained(null); }}>
                  {RL_ELIGIBLE.map((id) => <option key={id} value={id}>{getDrug(id).name}{model?.policies?.[id] ? ' ✓' : ''}</option>)}
                </Select>
              </Field>
              <NumberField label="Training episodes" value={episodes} min={50} max={5000} step={50} onChange={(v) => setEpisodes(Math.round(v))} hint={`Each episode = ${4} dose-titration decisions on a new virtual patient`} />
              <Button icon={<Play className="size-4" />} onClick={train} loading={progress !== null}>{saved ? 'Continue training' : 'Train policy'}</Button>
              {progress !== null && (
                <div role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Training progress" className="h-2 overflow-hidden rounded bg-surface-3"><div className="h-full bg-primary" style={{ width: `${progress * 100}%` }} /></div>
              )}
              {trained && <Button icon={<Save className="size-4" />} onClick={savePolicy}>Save policy</Button>}
              <div className="rounded-xl bg-surface-2 p-3 text-xs text-fg-2">
                <p className="font-semibold text-fg">How it learns</p>
                <p className="mt-1"><strong>State:</strong> kidney band × weight × age × metabolic genotype × last measured exposure. <strong>Action:</strong> {RL_ACTIONS.join('×, ')}× standard dose. <strong>Reward:</strong> +1 in target, −0.6 below, −1 above, −3 toxic, small penalty for large changes. Tabular Q-learning (α 0.2, γ 0.7, ε-greedy) on the twin simulator; every recorded real outcome then applies an extra update (α 0.5).</p>
              </div>
            </div>
          </Card>
          <div className="flex min-w-0 flex-col gap-4">
            {curveV.length > 1 ? (
              <Card title="Learning curve" subtitle="Mean episode reward (25-episode windows)">
                <TimeChart ariaLabel="RL learning curve" t={curveT} unit="reward" height={220} yDomain={['auto', 'auto']} xFormatter={(v) => `${Math.round(v)}`} xLabel="Episode" series={[{ def: { key: 'r', label: 'Mean reward', color: 'var(--s3)' }, values: curveV }]} />
              </Card>
            ) : (
              <Callout tone="info" title="No policy yet for this medicine">Train the agent to learn individualised titration rules from thousands of simulated patients. Recorded real outcomes will keep refining it.</Callout>
            )}
            {shown?.evaluation && (
              <Card title="Held-out evaluation" subtitle={`${shown.evaluation.subjects} unseen virtual patients after ${4} titration steps`}>
                <div className="grid gap-3 sm:grid-cols-3">
                  {(['pta', 'toxic', 'meanReward'] as const).map((k) => (
                    <div key={k} className="rounded-xl border border-line p-3">
                      <p className="text-xs text-muted">{k === 'pta' ? 'In target range' : k === 'toxic' ? 'Toxic exposure' : 'Mean reward'}</p>
                      <div className="mt-2 space-y-1.5">
                        {(['policy', 'standard'] as const).map((who) => {
                          const val = shown.evaluation![who][k];
                          const pct = k === 'meanReward' ? null : val * 100;
                          return (
                            <div key={who}>
                              <div className="flex justify-between text-xs"><span>{who === 'policy' ? 'RL policy' : 'Standard dose'}</span><span className="font-semibold tabular">{pct !== null ? `${pct.toFixed(0)}%` : fmt(val)}</span></div>
                              {pct !== null && <div className="h-2 overflow-hidden rounded bg-surface-3"><div className="h-full rounded" style={{ width: `${pct}%`, background: who === 'policy' ? 'var(--s1)' : 'var(--line-strong)' }} /></div>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
            {shown && (
              <Card title="Learned titration policy" subtitle={`${shown.episodes} simulated episodes · ${shown.realUpdates} real-outcome updates · ${relativeTime(Date.parse(shown.trainedAt))}`}>
                <PolicyMap policy={shown} />
              </Card>
            )}
          </div>
        </div>
      )}

      {tab === 'pk' && (
        <Card title="Learned population pharmacokinetics" subtitle="Pooled individual Bayesian (MAP) estimates from recorded measured levels, applied to future patients with shrinkage n / (n + 5)">
          {Object.keys(priors).length === 0 ? <p className="text-sm text-muted">Record outcomes with measured drug levels (Body twin → Record real outcome) to personalise clearance and volume for your patient population.</p> : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted"><th className="pb-2 font-medium">Medicine</th><th className="pb-2 font-medium">Patients</th><th className="pb-2 font-medium">Clearance vs literature</th><th className="pb-2 font-medium">Volume vs literature</th><th className="pb-2 font-medium">Weight given to local data</th></tr></thead>
              <tbody>
                {Object.entries(priors).map(([id, p]) => (
                  <tr key={id} className="border-t border-line tabular">
                    <td className="py-2 font-medium">{getDrug(id).name}</td>
                    <td>{p.n}</td>
                    <td><Badge tone={Math.abs(p.clFactor - 1) > 0.15 ? 'warn' : 'neutral'}>×{p.clFactor.toFixed(2)}</Badge></td>
                    <td>×{p.vFactor.toFixed(2)}</td>
                    <td>{(p.weight * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === 'ae' && model && (
        <Card title="Organ side-effect models" subtitle="Logistic regression per organ: online MAP updates (L2 toward the mechanistic prior) from observed adverse events">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-xs">
              <thead><tr className="text-left text-muted"><th className="pb-2 font-medium">Organ</th><th className="pb-2 font-medium">Samples</th>{AE_FEATURES.map((f) => <th key={f} className="pb-2 font-medium">{f}</th>)}</tr></thead>
              <tbody>
                {aeRows.map((r) => (
                  <tr key={r.organ} className="border-t border-line tabular">
                    <td className="py-1.5 font-medium">{ORGAN_LABEL[r.organ]}</td>
                    <td>{r.n}</td>
                    {r.w.map((w, i) => {
                      const dlt = w - AE_PRIOR_WEIGHTS[i];
                      return <td key={i} className={cx(Math.abs(dlt) > 0.02 && (dlt > 0 ? 'text-danger' : 'text-info'), Math.abs(dlt) > 0.02 && 'font-semibold')} title={`prior ${AE_PRIOR_WEIGHTS[i]}`}>{w.toFixed(2)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-muted">Bold values have moved from the prior: red = feature now increases risk more, blue = less.</p>
        </Card>
      )}

      {tab === 'outcomes' && (
        <Card title="Outcome registry" actions={<Button size="sm" variant="ghost" icon={<RefreshCcw className="size-3.5" />} onClick={load}>Refresh</Button>}>
          {outcomes.length === 0 ? <p className="text-sm text-muted">No outcomes recorded yet.</p> : (
            <ul className="divide-y divide-line">
              {outcomes.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="font-medium">{getDrug(o.drugId).name}</span>
                  <span className="text-xs text-muted">{relativeTime(o.createdAt)}</span>
                  {o.sideEffects.filter((s) => s.occurred).map((s) => <Badge key={s.organ} tone="danger">{s.organ}</Badge>)}
                  {o.observations.length > 0 && <Badge tone="info">{o.observations.length} levels</Badge>}
                  <span className="ml-auto text-xs text-muted">{Object.keys(o.learned).join(' · ') || 'stored'}</span>
                  <button className="rounded-md p-1 text-muted hover:text-danger" aria-label="Delete outcome" onClick={() => del(`/outcomes/${o.id}`).then(load)}><Trash2 className="size-4" /></button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] text-muted">Deleting a record removes it from the registry; learned parameters are cumulative — use “Reset learned model” to start over.</p>
        </Card>
      )}
      <ConfirmDialog open={resetOpen} title="Reset learned model?" body="All learned pharmacokinetic priors, side-effect weights and RL policies will be discarded. Recorded outcomes remain in the registry." confirmLabel="Reset" onClose={() => setResetOpen(false)} onConfirm={async () => { await del('/learning/model'); setResetOpen(false); toast('Learned model reset'); load(); }} />
    </div>
  );
}
