import { useEffect, useMemo, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router-dom';
import { Activity, Save, Trash2, User, History, ScanSearch, AlertTriangle } from 'lucide-react';
import { analyzeHistory, getDrug, ORGANS, type Organ, type Patient } from '@medcare/engine';
import { del, get, put } from '../lib/api';
import { useToast } from '../lib/toast';
import { fmt } from '../lib/format';
import { Badge, Button, Callout, Card, ConfirmDialog, PageHeader, Skeleton, Tabs, cx } from '../components/ui';
import { HistoryEditor, PatientForm, PhysiologySummary } from '../components/PatientForm';
import { BodyMap, ORGAN_LABEL, type OrganState } from '../components/BodyMap';
import { ReportImport } from '../components/ReportImport';
import { TimeChart } from '../components/charts';

type Tab = 'profile' | 'history' | 'retro';

export function Retrospective({ patient }: { patient: Patient }) {
  const h = useMemo(() => analyzeHistory(patient), [patient]);
  const organs = useMemo(() => {
    const o = {} as Record<Organ, OrganState>;
    for (const k of ORGANS) {
      const notes: string[] = [];
      for (const l of h.lasting) if (l.organ === k) notes.push(l.text);
      for (const c of h.cumulative) if (c.limit?.organ === k) notes.push(`${getDrug(c.drugId).name}: ${c.limit.pct.toFixed(0)}% of cumulative threshold`);
      o[k] = { therapeutic: 0, risk: h.organBurden[k], notes };
    }
    return o;
  }, [h]);
  if (!patient.medicationHistory.length && !patient.procedures.length) {
    return <Callout tone="info" title="No history recorded">Add past medication courses and procedures in the History tab. The twin will then reconstruct what those exposures have already done to the body.</Callout>;
  }
  return (
    <div className="grid gap-5 xl:grid-cols-[1.2fr_1fr]">
      <div className="flex flex-col gap-5">
        <Card title="Lasting effects on the twin today" subtitle="Derived from reconstructed drug exposure, enzyme turnover and procedure physiology.">
          {h.lasting.length === 0 ? (
            <p className="text-sm text-muted">No clinically relevant residual effects detected.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {h.lasting.map((l, i) => (
                <li key={i} className={cx('rounded-xl border p-3 text-sm', l.severity === 'major' ? 'border-danger/30 bg-danger-soft/40' : 'border-line')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={l.severity === 'major' ? 'danger' : l.severity === 'moderate' ? 'warn' : 'info'}>
                      {l.severity === 'major' && <AlertTriangle className="size-3" aria-hidden />}
                      {l.kind}
                    </Badge>
                    <span className="font-medium">{l.source}</span>
                  </div>
                  <p className="mt-1 text-fg-2">{l.text}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Cumulative exposure" subtitle="Lifetime dose recorded in the twin's history versus organ-toxicity thresholds.">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="pb-2 font-medium">Medicine</th>
                  <th className="pb-2 text-right font-medium">Courses</th>
                  <th className="pb-2 text-right font-medium">Days</th>
                  <th className="pb-2 text-right font-medium">Total</th>
                  <th className="pb-2 pl-4 font-medium">Threshold</th>
                </tr>
              </thead>
              <tbody>
                {h.cumulative.map((c) => (
                  <tr key={c.drugId} className="border-t border-line">
                    <td className="py-2 font-medium">{getDrug(c.drugId).name}</td>
                    <td className="py-2 text-right tabular">{c.courses}</td>
                    <td className="py-2 text-right tabular">{fmt(c.days)}</td>
                    <td className="py-2 text-right tabular">{fmt(c.totalMg)} mg{c.limit?.unit === 'mg/m2' ? ` (${fmt(c.totalPerM2)} mg/m²)` : ''}</td>
                    <td className="py-2 pl-4">
                      {c.limit ? (
                        <div className="min-w-[140px]">
                          <div className="h-2 overflow-hidden rounded bg-surface-3" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(c.limit.pct)} aria-label={`${c.limit.pct.toFixed(0)}% of threshold`}>
                            <div className={cx('h-full rounded', c.limit.pct >= 100 ? 'bg-danger' : c.limit.pct >= 70 ? 'bg-warn' : 'bg-ok')} style={{ width: `${Math.min(100, c.limit.pct)}%` }} />
                          </div>
                          <p className="mt-0.5 text-[11px] text-muted">{c.limit.pct.toFixed(0)}% of {c.limit.value} {c.limit.unit} ({ORGAN_LABEL[c.limit.organ]})</p>
                        </div>
                      ) : <span className="text-xs text-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        {h.timeline && (
          <Card title="Reconstructed exposure history" subtitle={`From ${h.windowStart?.slice(0, 10)} to today (max 12 months).`}>
            <div className="flex flex-col gap-4">
              {h.timeline.drugIds.map((id, i) => {
                const d = getDrug(id);
                const r = h.residual.find((x) => x.drugId === id);
                return (
                  <div key={id}>
                    <div className="flex items-baseline justify-between">
                      <p className="text-sm font-medium">{d.name}</p>
                      {r && <p className="text-xs text-muted">Now: <span className="font-medium text-fg tabular">{fmt(r.value)} {r.unit}</span>{r.daysToWashout > 0.5 && ` · washout ≈ ${fmt(r.daysToWashout)} d`}</p>}
                    </div>
                    <TimeChart
                      ariaLabel={`${d.name} reconstructed concentration`}
                      t={h.timeline!.t}
                      unit={d.display.unit}
                      height={150}
                      series={[{ def: { key: id, label: d.name, color: `var(--s${(i % 8) + 1})` }, values: h.timeline!.series[id].conc }]}
                      band={d.therapeutic && d.therapeutic.basis !== 'auc24' ? { low: d.therapeutic.low, high: d.therapeutic.high, label: 'target' } : undefined}
                    />
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </div>
      <div className="flex flex-col gap-5">
        <Card title="Organ burden from history">
          <BodyMap organs={organs} compact />
        </Card>
        {Object.keys(h.enzymeState).length > 0 && (
          <Card title="Enzyme carry-over">
            <ul className="space-y-1 text-sm">
              {Object.entries(h.enzymeState).map(([k, v]) => (
                <li key={k} className="flex justify-between"><span>{k}</span><span className={cx('font-semibold tabular', v! > 1 ? 'text-info' : 'text-warn')}>{v!.toFixed(2)}× baseline</span></li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">The simulator applies this carry-over automatically when "Include history" is on.</p>
          </Card>
        )}
      </div>
    </div>
  );
}

export default function TwinDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [data, setData] = useState<Patient | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [tab, setTab] = useState<Tab>('profile');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<{ twin: { name: string; data: Patient } }>(`/twins/${id}`)
      .then((r) => {
        setName(r.twin.name);
        setData(r.twin.data);
        setSaved(JSON.stringify(r.twin.data) + r.twin.name);
      })
      .catch((e) => setError(e.message));
  }, [id]);
  const dirty = data !== null && JSON.stringify(data) + name !== saved;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  const save = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const n = data.name.trim() || name;
      await put(`/twins/${id}`, { name: n, data: { ...data, name: n } });
      setName(n);
      setSaved(JSON.stringify({ ...data, name: n }) + n);
      setData({ ...data, name: n });
      toast('Twin saved');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (error) return <Callout tone="danger" title="Could not load twin">{error} <Link to="/app/twins" className="underline">Back to twins</Link></Callout>;
  if (!data) return <div className="space-y-4"><Skeleton className="h-12 w-72" /><Skeleton className="h-96" /></div>;
  return (
    <div>
      <PageHeader
        icon={<User className="size-5" />}
        title={name}
        description={`${data.age} y · ${data.sex} · ${data.weightKg} kg · ${data.heightCm} cm`}
        actions={
          <>
            <ReportImport patient={data} onApply={(p) => { setData(p); toast('Report data applied — review and save'); }} />
            <Button variant="secondary" icon={<Trash2 className="size-4" />} onClick={() => setConfirm(true)}>Delete</Button>
            <Button variant="secondary" icon={<Activity className="size-4" />} onClick={() => nav(`/app/simulate?twin=${id}`)} disabled={dirty} title={dirty ? 'Save changes first' : undefined}>Simulate</Button>
            <Button icon={<Save className="size-4" />} onClick={save} loading={busy} disabled={!dirty}>{dirty ? 'Save changes' : 'Saved'}</Button>
          </>
        }
      />
      {dirty && <p className="-mt-3 mb-4 text-xs text-warn" role="status">Unsaved changes</p>}
      <div className="mb-5">
        <Tabs<Tab>
          label="Twin sections"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'profile', label: 'Profile & physiology', icon: <User className="size-4" /> },
            { id: 'history', label: 'History', icon: <History className="size-4" /> },
            { id: 'retro', label: 'Retrospective analysis', icon: <ScanSearch className="size-4" /> },
          ]}
        />
      </div>
      {tab === 'profile' && (
        <div className="grid gap-5 2xl:grid-cols-[1fr_380px]">
          <PatientForm value={data} onChange={setData} />
          <Card title="Derived physiology" subtitle="Updates live as you edit." className="h-fit 2xl:sticky 2xl:top-20">
            <PhysiologySummary patient={data} />
          </Card>
        </div>
      )}
      {tab === 'history' && <HistoryEditor value={data} onChange={setData} />}
      {tab === 'retro' && <Retrospective patient={data} />}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete this twin?"
        body={<>“{name}” and its history will be permanently deleted. Saved experiments that reference it are kept.</>}
        onConfirm={async () => {
          try {
            await del(`/twins/${id}`);
            setSaved(JSON.stringify(data) + name);
            toast('Twin deleted');
            nav('/app/twins');
          } catch (e) {
            toast((e as Error).message, 'error');
          }
        }}
      />
      {blocker.state === 'blocked' && (
        <ConfirmDialog open title="Discard unsaved changes?" body="You have edits to this twin that have not been saved." confirmLabel="Discard" onClose={() => blocker.reset()} onConfirm={() => blocker.proceed()} />
      )}
    </div>
  );
}
