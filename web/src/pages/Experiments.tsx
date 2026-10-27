import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderOpen, Trash2 } from 'lucide-react';
import { del, get } from '../lib/api';
import { useToast } from '../lib/toast';
import { relativeTime } from '../lib/format';
import { Badge, Card, ConfirmDialog, EmptyState, PageHeader, Select, Skeleton } from '../components/ui';

interface Row { id: string; name: string; kind: string; summary: Record<string, unknown>; createdAt: number }
const OPEN: Record<string, (id: string) => string> = { simulation: (id) => `/app/simulate?exp=${id}` };

export default function Experiments() {
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [kind, setKind] = useState('');
  const [confirm, setConfirm] = useState<Row | null>(null);
  const load = () => get<{ simulations: Row[] }>('/simulations').then((r) => setRows(r.simulations)).catch((e) => { toast(e.message, 'error'); setRows([]); });
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const list = (rows ?? []).filter((r) => !kind || r.kind === kind);
  return (
    <div>
      <PageHeader icon={<FolderOpen className="size-5" />} title="Saved experiments" description="Simulations, trials, TDM fits, OR debriefs and discovery runs you have saved." actions={
        <Select aria-label="Filter by type" value={kind} onChange={(e) => setKind(e.target.value)} className="w-44">
          <option value="">All types</option>
          {['simulation', 'trial', 'tdm', 'anesthesia', 'discovery'].map((k) => <option key={k} value={k}>{k}</option>)}
        </Select>
      } />
      {!rows ? <Skeleton className="h-60" /> : list.length === 0 ? (
        <EmptyState icon={<FolderOpen className="size-5" />} title="Nothing saved yet" body="Use the Save button in the simulator, trials, TDM or OR modules." action={<Link to="/app/simulate" className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg">Open simulator</Link>} />
      ) : (
        <Card bodyClass="p-0">
          <ul className="divide-y divide-line">
            {list.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  {OPEN[r.kind] ? <Link to={OPEN[r.kind](r.id)} className="font-medium hover:text-primary">{r.name}</Link> : <p className="font-medium">{r.name}</p>}
                  <p className="truncate text-xs text-muted">{Object.entries(r.summary).filter(([, v]) => typeof v !== 'object').slice(0, 4).map(([k, v]) => `${k}: ${typeof v === 'number' ? Number(v.toPrecision(4)) : String(v)}`).join(' · ')}</p>
                </div>
                <Badge>{r.kind}</Badge>
                <span className="text-xs text-muted">{relativeTime(r.createdAt)}</span>
                <button className="rounded-md p-1.5 text-muted hover:bg-danger-soft hover:text-danger" aria-label={`Delete ${r.name}`} onClick={() => setConfirm(r)}><Trash2 className="size-4" /></button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <ConfirmDialog open={!!confirm} title="Delete experiment?" body={`“${confirm?.name}” will be permanently removed.`} onClose={() => setConfirm(null)} onConfirm={async () => {
        try { await del(`/simulations/${confirm!.id}`); toast('Deleted'); setConfirm(null); void load(); } catch (e) { toast((e as Error).message, 'error'); }
      }} />
    </div>
  );
}
