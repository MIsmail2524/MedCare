import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { Settings as Cog, ShieldCheck, KeyRound, MonitorSmartphone, Download, Trash2 } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { del, get, patch, post } from '../lib/api';
import { useToast } from '../lib/toast';
import { applyTheme, getTheme, type Theme } from '../lib/theme';
import { relativeTime } from '../lib/format';
import { Badge, Button, Callout, Card, ConfirmDialog, Field, Input, PageHeader, Select } from '../components/ui';

interface Sess { id: string; current: boolean; createdAt: number; lastSeenAt: number; ip: string; userAgent: string }

export default function Settings() {
  const { user, refresh, logout } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const demo = !!user?.isDemo;
  const [profile, setProfile] = useState({ name: user?.name ?? '', organisation: user?.organisation ?? '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [disablePw, setDisablePw] = useState('');
  const [sessions, setSessions] = useState<Sess[]>([]);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const [delOpen, setDelOpen] = useState(false);
  const [delPw, setDelPw] = useState('');
  const loadSessions = () => get<{ sessions: Sess[] }>('/auth/sessions').then((r) => setSessions(r.sessions)).catch(() => undefined);
  useEffect(() => { void loadSessions(); }, []);
  const wrap = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast(ok); return true; } catch (e) { toast((e as Error).message, 'error'); return false; }
  };
  const exportData = async () => {
    const [twins, sims, comps, attempts] = await Promise.all([get('/twins'), get('/simulations'), get('/compounds'), get('/training/attempts')]);
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), user, twins, simulations: sims, compounds: comps, training: attempts }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'medcare-twin-export.json';
    a.click();
  };
  return (
    <div>
      <PageHeader icon={<Cog className="size-5" />} title="Settings & security" description="Manage your profile, password, two-factor authentication, sessions and data." />
      {demo && <div className="mb-5"><Callout tone="warn" title="Shared demo account">Account and security changes are disabled on the public demo account. Create your own account to use 2FA and keep private data.</Callout></div>}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Profile">
          <div className="flex flex-col gap-3">
            <Field label="Email" htmlFor="em"><Input id="em" value={user?.email ?? ''} disabled /></Field>
            <Field label="Name" htmlFor="nm"><Input id="nm" value={profile.name} maxLength={80} onChange={(e) => setProfile({ ...profile, name: e.target.value })} disabled={demo} /></Field>
            <Field label="Organisation" htmlFor="org"><Input id="org" value={profile.organisation} maxLength={120} onChange={(e) => setProfile({ ...profile, organisation: e.target.value })} disabled={demo} /></Field>
            <p className="text-xs text-muted">Role: <Badge>{user?.role}</Badge></p>
            <Button className="self-start" disabled={demo || !profile.name.trim()} onClick={() => wrap(() => patch('/auth/profile', { name: profile.name, organisation: profile.organisation || undefined }).then(refresh), 'Profile updated')}>Save profile</Button>
          </div>
        </Card>
        <Card title="Appearance">
          <Field label="Theme" htmlFor="th">
            <Select id="th" value={theme} onChange={(e) => { const t = e.target.value as Theme; setTheme(t); applyTheme(t); }}>
              <option value="system">Match system</option><option value="light">Light</option><option value="dark">Dark</option>
            </Select>
          </Field>
        </Card>
        <Card title={<span className="flex items-center gap-2"><KeyRound className="size-4" aria-hidden />Change password</span>}>
          <form className="flex flex-col gap-3" onSubmit={async (e) => {
            e.preventDefault();
            setPwErr(null);
            if (pw.newPassword !== pw.confirm) { setPwErr('New passwords do not match'); return; }
            if (await wrap(() => post('/auth/password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword }), 'Password changed — other sessions signed out')) { setPw({ currentPassword: '', newPassword: '', confirm: '' }); void loadSessions(); }
          }}>
            <input type="text" autoComplete="username" value={user?.email ?? ''} readOnly hidden />
            <Field label="Current password" htmlFor="cp"><Input id="cp" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} disabled={demo} /></Field>
            <Field label="New password" htmlFor="np" hint="At least 10 characters"><Input id="np" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} disabled={demo} /></Field>
            <Field label="Confirm new password" htmlFor="np2" error={pwErr ?? undefined}><Input id="np2" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} disabled={demo} /></Field>
            <Button type="submit" className="self-start" disabled={demo || !pw.currentPassword || !pw.newPassword}>Update password</Button>
          </form>
        </Card>
        <Card title={<span className="flex items-center gap-2"><ShieldCheck className="size-4" aria-hidden />Two-factor authentication</span>} subtitle="Time-based one-time codes (RFC 6238) from any authenticator app.">
          {user?.totpEnabled ? (
            <div className="flex flex-col gap-3">
              <Badge tone="ok">Enabled</Badge>
              <Field label="Confirm password to disable" htmlFor="dp"><Input id="dp" type="password" autoComplete="current-password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} /></Field>
              <Button variant="danger" className="self-start" disabled={!disablePw} onClick={() => wrap(() => post('/auth/totp/disable', { currentPassword: disablePw }).then(refresh), '2FA disabled').then(() => setDisablePw(''))}>Disable 2FA</Button>
            </div>
          ) : setup ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm">Scan this QR code with your authenticator, then enter the 6-digit code.</p>
              <img src={setup.qr} alt="QR code for authenticator setup" className="size-44 rounded-lg bg-white p-2" />
              <p className="text-xs text-muted">Manual key: <code className="break-all rounded bg-surface-2 px-1">{setup.secret}</code></p>
              <Field label="Verification code" htmlFor="code"><Input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
              <Button className="self-start" disabled={code.length !== 6} onClick={() => wrap(() => post('/auth/totp/enable', { code }).then(refresh), '2FA enabled').then((ok) => ok && setSetup(null))}>Verify & enable</Button>
            </div>
          ) : (
            <Button disabled={demo} onClick={async () => {
              try {
                const r = await post<{ secret: string; otpauthUrl: string }>('/auth/totp/setup');
                setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 220 }) });
              } catch (e) { toast((e as Error).message, 'error'); }
            }}>Set up 2FA</Button>
          )}
        </Card>
        <Card title={<span className="flex items-center gap-2"><MonitorSmartphone className="size-4" aria-hidden />Active sessions</span>} actions={<Button size="sm" variant="secondary" onClick={() => wrap(() => post('/auth/sessions/revoke-others').then(loadSessions), 'Other sessions signed out')}>Sign out others</Button>}>
          <ul className="divide-y divide-line text-sm">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0"><p className="truncate">{s.userAgent || 'Unknown device'}</p><p className="text-xs text-muted">{s.ip} · active {relativeTime(s.lastSeenAt)}</p></div>
                {s.current && <Badge tone="ok">This device</Badge>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Your data">
          <div className="flex flex-col gap-3">
            <Button variant="secondary" className="self-start" icon={<Download className="size-4" />} onClick={exportData}>Export all my data (JSON)</Button>
            <Button variant="danger" className="self-start" icon={<Trash2 className="size-4" />} disabled={demo} onClick={() => setDelOpen(true)}>Delete account</Button>
          </div>
        </Card>
      </div>
      <ConfirmDialog open={delOpen} title="Delete your account permanently?" confirmLabel="Delete account" onClose={() => setDelOpen(false)}
        body={<div className="flex flex-col gap-3"><p>All twins, experiments, compounds and training history will be erased. This cannot be undone.</p><Field label="Confirm with your password" htmlFor="delpw"><Input id="delpw" type="password" autoComplete="current-password" value={delPw} onChange={(e) => setDelPw(e.target.value)} /></Field></div>}
        onConfirm={async () => { if (await wrap(() => del('/auth/account', { currentPassword: delPw }), 'Account deleted')) { await logout(); nav('/'); } }} />
    </div>
  );
}
