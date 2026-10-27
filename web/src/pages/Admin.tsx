import { useEffect, useState } from 'react';
import { Shield } from 'lucide-react';
import { get, patch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { relativeTime } from '../lib/format';
import { Badge, Card, PageHeader, Select, Tabs } from '../components/ui';

interface U { id: string; email: string; name: string; role: string; totp_enabled: number; disabled: number; is_demo: number; created_at: number; last_login_at: number | null; locked_until: number }
interface Ev { id: number; action: string; target: string | null; ip: string | null; meta: string | null; created_at: number; email: string | null }

export default function Admin() {
  const { user } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'users' | 'audit'>('users');
  const [users, setUsers] = useState<U[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const load = () => {
    get<{ users: U[] }>('/admin/users').then((r) => setUsers(r.users)).catch((e) => toast(e.message, 'error'));
    get<{ events: Ev[] }>('/admin/audit?limit=200').then((r) => setEvents(r.events)).catch(() => undefined);
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (id: string, body: Record<string, unknown>) => patch(`/admin/users/${id}`, body).then(() => { toast('User updated'); load(); }).catch((e) => toast(e.message, 'error'));
  return (
    <div>
      <PageHeader icon={<Shield className="size-5" />} title="Administration" description="User management and security audit trail." />
      <div className="mb-4"><Tabs label="Admin sections" value={tab} onChange={setTab} tabs={[{ id: 'users', label: `Users (${users.length})` }, { id: 'audit', label: 'Audit log' }]} /></div>
      {tab === 'users' ? (
        <Card bodyClass="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead><tr className="border-b border-line text-left text-xs text-muted">{['User', 'Role', 'Security', 'Created', 'Last login', 'Status'].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-line">
                    <td className="px-4 py-2"><p className="font-medium">{u.name}</p><p className="text-xs text-muted">{u.email}</p></td>
                    <td className="px-4 py-2">
                      <Select aria-label={`Role for ${u.email}`} value={u.role} disabled={u.id === user?.id} onChange={(e) => update(u.id, { role: e.target.value })} className="h-8 w-32 text-xs">
                        {['student', 'clinician', 'researcher', 'admin'].map((r) => <option key={r}>{r}</option>)}
                      </Select>
                    </td>
                    <td className="px-4 py-2">{u.totp_enabled ? <Badge tone="ok">2FA</Badge> : <Badge>password</Badge>} {u.locked_until > Date.now() && <Badge tone="warn">locked</Badge>} {u.is_demo ? <Badge tone="info">demo</Badge> : null}</td>
                    <td className="px-4 py-2 text-xs text-muted">{relativeTime(u.created_at)}</td>
                    <td className="px-4 py-2 text-xs text-muted">{u.last_login_at ? relativeTime(u.last_login_at) : '—'}</td>
                    <td className="px-4 py-2">
                      <button disabled={u.id === user?.id} onClick={() => update(u.id, { disabled: !u.disabled })} className={`rounded-lg px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${u.disabled ? 'bg-danger-soft text-danger' : 'bg-ok-soft text-ok'}`}>
                        {u.disabled ? 'Disabled — enable' : 'Active — disable'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Card bodyClass="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead><tr className="border-b border-line text-left text-xs text-muted">{['Time', 'Actor', 'Action', 'Target', 'IP'].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-line">
                    <td className="whitespace-nowrap px-4 py-1.5 text-xs text-muted tabular">{new Date(e.created_at).toLocaleString()}</td>
                    <td className="px-4 py-1.5 text-xs">{e.email ?? '—'}</td>
                    <td className="px-4 py-1.5"><Badge tone={e.action.includes('failed') || e.action.includes('locked') ? 'danger' : e.action.startsWith('admin') ? 'warn' : 'neutral'}>{e.action}</Badge></td>
                    <td className="max-w-[220px] truncate px-4 py-1.5 font-mono text-xs text-muted">{e.target ?? ''}</td>
                    <td className="px-4 py-1.5 text-xs text-muted">{e.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
