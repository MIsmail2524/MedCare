import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Beaker, FlaskConical, FolderOpen, GraduationCap, Network, Plus, Sigma, Syringe, Users, ArrowRight } from 'lucide-react';
import { derivePhysiology, TRAINING_CASES } from '@medcare/engine';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTwins } from '../lib/twins';
import { relativeTime } from '../lib/format';
import { Badge, Card, EmptyState, Skeleton, Stat } from '../components/ui';

interface Stats { twins: number; simulations: number; compounds: number; attempts: number }
interface SimRow { id: string; name: string; kind: string; createdAt: number }

const ACTIONS = [
  { to: '/app/simulate', icon: Activity, title: 'Simulate a regimen', body: 'Concentrations, effects, QTc and organ load' },
  { to: '/app/interactions', icon: Network, title: 'Check interactions', body: 'Mechanism-based DDI & PGx screen' },
  { to: '/app/tdm', icon: Sigma, title: 'Bayesian dosing', body: 'Fit measured levels, get next dose' },
  { to: '/app/trials', icon: FlaskConical, title: 'Run a virtual trial', body: 'Population variability & target attainment' },
  { to: '/app/anesthesia', icon: Syringe, title: 'Operating room', body: 'TCI anaesthesia training scenarios' },
  { to: '/app/discovery', icon: Beaker, title: 'New compound', body: 'First-in-human dose & SAD/MAD' },
];

export default function Dashboard() {
  const { user } = useAuth();
  const { twins } = useTwins();
  const [stats, setStats] = useState<Stats | null>(null);
  const [sims, setSims] = useState<SimRow[] | null>(null);
  const [attempts, setAttempts] = useState<{ caseId: string; score: number; total: number }[]>([]);
  useEffect(() => {
    get<Stats>('/stats').then(setStats).catch(() => setStats({ twins: 0, simulations: 0, compounds: 0, attempts: 0 }));
    get<{ simulations: SimRow[] }>('/simulations').then((r) => setSims(r.simulations.slice(0, 5))).catch(() => setSims([]));
    get<{ attempts: { caseId: string; score: number; total: number }[] }>('/training/attempts').then((r) => setAttempts(r.attempts)).catch(() => undefined);
  }, []);
  const completed = new Set(attempts.filter((a) => a.score === a.total).map((a) => a.caseId));
  const hour = new Date().getHours();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Good {hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, {user?.name.split(' ')[0]}</h1>
        <p className="mt-1 text-sm text-muted">Pick a twin, choose an experiment, and see the body respond.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats ? (
          <>
            <Stat label="Digital twins" value={stats.twins} />
            <Stat label="Saved experiments" value={stats.simulations} />
            <Stat label="Compounds" value={stats.compounds} />
            <Stat label="Training cases mastered" value={`${completed.size}/${TRAINING_CASES.length}`} />
          </>
        ) : (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[76px]" />)
        )}
      </div>
      <section aria-labelledby="qa">
        <h2 id="qa" className="mb-3 text-sm font-semibold text-fg-2">Quick actions</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {ACTIONS.map((a) => (
            <Link key={a.to} to={a.to} className="group flex items-center gap-3 rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-primary">
              <span className="rounded-xl bg-primary-soft p-2.5 text-primary"><a.icon className="size-5" aria-hidden /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{a.title}</span>
                <span className="block text-xs text-muted">{a.body}</span>
              </span>
              <ArrowRight className="size-4 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
            </Link>
          ))}
        </div>
      </section>
      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Card title="Your digital twins" actions={<Link to="/app/twins" className="text-sm font-medium text-primary hover:underline">View all</Link>}>
          {!twins ? (
            <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
          ) : twins.length === 0 ? (
            <EmptyState icon={<Users className="size-5" />} title="No twins yet" body="Create a virtual patient with their physiology, genotype and history." action={<Link to="/app/twins" className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg"><Plus className="size-4" />New twin</Link>} />
          ) : (
            <ul className="divide-y divide-line">
              {twins.slice(0, 5).map((t) => {
                const p = derivePhysiology(t.data);
                return (
                  <li key={t.id}>
                    <Link to={`/app/twins/${t.id}`} className="flex items-center gap-3 py-3 hover:text-primary">
                      <span className="grid size-9 place-items-center rounded-full bg-surface-2 text-sm font-semibold">{t.data.name[0]}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{t.name}</span>
                        <span className="block text-xs text-muted">{t.data.age} y · {t.data.sex} · {t.data.weightKg} kg</span>
                      </span>
                      <span className="hidden gap-1 sm:flex">
                        <Badge tone={p.crcl < 30 ? 'danger' : p.crcl < 60 ? 'warn' : 'neutral'}>CrCl {Math.round(p.crcl)}</Badge>
                        {t.data.medicationHistory.length > 0 && <Badge tone="info">{t.data.medicationHistory.length} meds</Badge>}
                        {t.data.procedures.length > 0 && <Badge>{t.data.procedures.length} procedures</Badge>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <div className="flex flex-col gap-6">
          <Card title="Recent experiments" actions={<Link to="/app/experiments" className="text-sm font-medium text-primary hover:underline">All</Link>}>
            {!sims ? <Skeleton className="h-20" /> : sims.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted"><FolderOpen className="size-4" aria-hidden /> Save a simulation to see it here.</p>
            ) : (
              <ul className="space-y-2">
                {sims.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{s.name}</span>
                    <span className="flex shrink-0 items-center gap-2"><Badge>{s.kind}</Badge><span className="text-xs text-muted">{relativeTime(s.createdAt)}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Continue learning">
            <ul className="space-y-2">
              {TRAINING_CASES.filter((c) => !completed.has(c.id)).slice(0, 3).map((c) => (
                <li key={c.id}>
                  <Link to={`/app/training?case=${c.id}`} className="flex items-center gap-3 rounded-lg p-2 hover:bg-surface-2">
                    <GraduationCap className="size-4 text-primary" aria-hidden />
                    <span className="flex-1 text-sm">{c.title}</span>
                    <Badge>{c.difficulty}</Badge>
                  </Link>
                </li>
              ))}
              {completed.size === TRAINING_CASES.length && <li className="text-sm text-ok">All cases mastered — great work.</li>}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
