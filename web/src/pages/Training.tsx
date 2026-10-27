import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GraduationCap, CheckCircle2, XCircle, ArrowLeft, Trophy, Clock } from 'lucide-react';
import { derivePhysiology, evaluateAlerts, getDrug, simulate, TRAINING_CASES, type TrainingCase } from '@medcare/engine';
import { get, post } from '../lib/api';
import { useToast } from '../lib/toast';
import { fmt } from '../lib/format';
import { Badge, Button, Card, PageHeader, cx } from '../components/ui';
import { TimeChart } from '../components/charts';
import { AlertList } from '../components/clinical';

interface Attempt { caseId: string; score: number; total: number; createdAt: number }

function CasePlayer({ c, onExit, onDone }: { c: TrainingCase; onExit: () => void; onDone: () => void }) {
  const toast = useToast();
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<{ score: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const sim = useMemo(() => simulate({ patient: c.patient, regimens: c.regimens.map((r, i) => ({ ...r, id: `r${i}` })) }), [c]);
  const alerts = useMemo(() => evaluateAlerts(c.patient, derivePhysiology(c.patient), sim.drugIds, sim), [c, sim]);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post<{ attempt: { score: number; total: number } }>('/training/attempts', { caseId: c.id, answers });
      setResult(r.attempt);
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const allAnswered = c.questions.every((q) => revealed[q.id]);
  return (
    <div>
      <Button variant="ghost" size="sm" icon={<ArrowLeft className="size-4" />} onClick={onExit}>All cases</Button>
      <div className="mt-3 grid gap-6 xl:grid-cols-[1fr_1fr]">
        <div className="flex flex-col gap-4">
          <Card title={c.title} subtitle={`${c.specialty} · ${c.difficulty} · ~${c.minutes} min`}>
            <p className="text-sm leading-relaxed">{c.vignette}</p>
            <p className="mt-3 text-xs font-medium text-fg-2">Learning objectives</p>
            <ul className="mt-1 list-disc pl-4 text-xs text-fg-2">{c.learningObjectives.map((o) => <li key={o}>{o}</li>)}</ul>
          </Card>
          <Card title="Live simulation of this case">
            <div className="flex flex-col gap-4">
              {sim.drugIds.map((id, i) => {
                const d = getDrug(id);
                const m = sim.metrics[id];
                return (
                  <div key={id}>
                    <p className="text-sm font-medium">{d.name} <span className="text-xs font-normal text-muted">· Cmax {fmt(m.cmax)} {m.unit}{m.targetValue !== null && ` · ${d.therapeutic!.basis} ${fmt(m.targetValue)}`}</span></p>
                    <TimeChart ariaLabel={`${d.name} concentration`} t={sim.t} unit={d.display.unit} height={170} series={[{ def: { key: id, label: d.name, color: `var(--s${i + 1})` }, values: sim.series[id].active ?? sim.series[id].conc }]} band={d.therapeutic && d.therapeutic.basis !== 'auc24' ? { ...d.therapeutic, label: 'target' } : undefined} toxic={d.toxic && d.toxic.basis !== 'auc24' ? { value: d.toxic.value, label: 'toxic' } : undefined} />
                  </div>
                );
              })}
            </div>
          </Card>
          {allAnswered && <Card title="Decision support for this case"><AlertList alerts={alerts} /></Card>}
        </div>
        <div className="flex flex-col gap-4">
          {c.questions.map((q, qi) => (
            <Card key={q.id} title={`Question ${qi + 1}`}>
              <fieldset>
                <legend className="mb-3 text-sm font-medium">{q.prompt}</legend>
                <div className="flex flex-col gap-2">
                  {q.options.map((o, oi) => {
                    const chosen = answers[q.id] === oi;
                    const show = revealed[q.id];
                    const correct = oi === q.answer;
                    return (
                      <label key={oi} className={cx('flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition-colors', show && correct && 'border-ok bg-ok-soft', show && chosen && !correct && 'border-danger bg-danger-soft', !show && chosen && 'border-primary bg-primary-soft', !show && !chosen && 'border-line hover:border-line-strong', show && 'cursor-default')}>
                        <input type="radio" name={q.id} className="mt-0.5 accent-[var(--primary)]" checked={chosen} disabled={show} onChange={() => setAnswers({ ...answers, [q.id]: oi })} />
                        <span className="flex-1">{o}</span>
                        {show && correct && <CheckCircle2 className="size-4 text-ok" aria-label="Correct answer" />}
                        {show && chosen && !correct && <XCircle className="size-4 text-danger" aria-label="Your answer (incorrect)" />}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              {revealed[q.id] ? (
                <p className="mt-3 rounded-lg bg-surface-2 p-3 text-sm text-fg-2" role="status"><span className="font-semibold text-fg">{answers[q.id] === q.answer ? 'Correct. ' : 'Not quite. '}</span>{q.explanation}</p>
              ) : (
                <Button className="mt-3" size="sm" disabled={answers[q.id] === undefined} onClick={() => setRevealed({ ...revealed, [q.id]: true })}>Check answer</Button>
              )}
            </Card>
          ))}
          {result ? (
            <Card>
              <div className="flex items-center gap-3">
                <Trophy className={cx('size-8', result.score === result.total ? 'text-ok' : 'text-warn')} aria-hidden />
                <div><p className="text-lg font-semibold">{result.score} / {result.total} correct</p><p className="text-xs text-muted">Scored and recorded by the server.</p></div>
              </div>
            </Card>
          ) : (
            <Button onClick={submit} loading={busy} disabled={!allAnswered}>Submit case</Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Training() {
  const [params, setParams] = useSearchParams();
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [leaders, setLeaders] = useState<{ name: string; score: number; total: number; cases: number }[]>([]);
  const load = () => {
    get<{ attempts: Attempt[] }>('/training/attempts').then((r) => setAttempts(r.attempts)).catch(() => undefined);
    get<{ leaders: typeof leaders }>('/training/leaderboard').then((r) => setLeaders(r.leaders)).catch(() => undefined);
  };
  useEffect(load, []);
  const caseId = params.get('case');
  const active = TRAINING_CASES.find((c) => c.id === caseId);
  if (active) return <CasePlayer c={active} onExit={() => setParams({})} onDone={load} />;
  const best = (id: string) => attempts.filter((a) => a.caseId === id).reduce<Attempt | null>((b, a) => (!b || a.score > b.score ? a : b), null);
  return (
    <div>
      <PageHeader icon={<GraduationCap className="size-5" />} title="Clinical training" description="Case-based learning linked to live simulations. Each case is scored on the server; retry as often as you like." />
      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div className="grid gap-4 md:grid-cols-2">
          {TRAINING_CASES.map((c) => {
            const b = best(c.id);
            return (
              <button key={c.id} onClick={() => setParams({ case: c.id })} className="flex flex-col rounded-2xl border border-line bg-surface p-4 text-left shadow-[var(--shadow)] transition-colors hover:border-primary">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="primary">{c.specialty}</Badge>
                  <Badge>{c.difficulty}</Badge>
                  {b && <Badge tone={b.score === b.total ? 'ok' : 'warn'}>best {b.score}/{b.total}</Badge>}
                </div>
                <p className="mt-2 font-semibold">{c.title}</p>
                <p className="mt-1 line-clamp-3 text-sm text-fg-2">{c.vignette}</p>
                <p className="mt-auto flex items-center gap-1 pt-3 text-xs text-muted"><Clock className="size-3.5" aria-hidden /> ~{c.minutes} min · {c.questions.length} questions</p>
              </button>
            );
          })}
        </div>
        <Card title="Leaderboard" subtitle="Best score per case, all learners">
          {leaders.length === 0 ? <p className="text-sm text-muted">Complete a case to appear here.</p> : (
            <ol className="space-y-2">
              {leaders.map((l, i) => (
                <li key={i} className="flex items-center gap-3 text-sm">
                  <span className={cx('grid size-6 place-items-center rounded-full text-xs font-semibold', i === 0 ? 'bg-warn-soft text-warn' : 'bg-surface-2')}>{i + 1}</span>
                  <span className="flex-1 truncate">{l.name}</span>
                  <span className="tabular text-muted">{l.score}/{l.total}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
}
