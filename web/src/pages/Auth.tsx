import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { HeartPulse, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Button, Callout, Field, Input, Select } from '../components/ui';

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-[linear-gradient(160deg,#0b5cad,#063a72)] p-10 text-white lg:flex">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <HeartPulse className="size-5" aria-hidden /> MedCare Twin
        </Link>
        <div>
          <p className="text-3xl font-semibold leading-tight">See what a medicine will do — before the patient takes it.</p>
          <p className="mt-4 max-w-md text-white/80">Physiology-based digital twins that combine pharmacokinetics, pharmacogenomics, organ function, drug interactions and medical history.</p>
        </div>
        <p className="flex items-center gap-2 text-sm text-white/70">
          <ShieldCheck className="size-4" aria-hidden /> Encrypted sessions · 2FA · audit logging
        </p>
      </div>
      <main className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <Link to="/" className="mb-8 flex items-center gap-2 font-semibold lg:hidden">
            <HeartPulse className="size-5 text-primary" aria-hidden /> MedCare Twin
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
      </main>
    </div>
  );
}

function PasswordInput({ id, value, onChange, autoComplete, invalid }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; invalid?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input id={id} type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} required maxLength={128} aria-invalid={invalid} className="pr-10" />
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute inset-y-0 right-2 flex items-center px-1 text-muted hover:text-fg" aria-label={show ? 'Hide password' : 'Show password'}>
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e?: FormEvent, creds?: { email: string; password: string }) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(creds?.email ?? email, creds?.password ?? password, totp);
      const from = loc.state?.from;
      nav(from && from.startsWith('/app') ? from : '/app', { replace: true });
    } catch (err) {
      const ae = err as ApiError;
      if (ae.details?.some((d) => d.path === 'totp')) setNeedTotp(true);
      setError(ae.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Sign in" subtitle="Welcome back to your digital twin workspace.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} />
        </Field>
        <Field label="Password" htmlFor="password">
          <PasswordInput id="password" value={password} onChange={setPassword} autoComplete="current-password" />
        </Field>
        {needTotp && (
          <Field label="Authenticator code" htmlFor="totp" hint="6-digit code from your authenticator app">
            <Input id="totp" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} autoFocus />
          </Field>
        )}
        <Button type="submit" loading={busy} disabled={!email || !password}>
          Sign in
        </Button>
        <div className="relative py-1 text-center text-xs text-muted">
          <span className="bg-bg px-2">or</span>
        </div>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => submit(undefined, { email: 'demo@medcare.dev', password: 'MedCare-Demo-2026' })}>
          Explore with the demo account
        </Button>
        <p className="text-center text-sm text-muted">
          New here?{' '}
          <Link to="/register" className="font-medium text-primary hover:underline">
            Create an account
          </Link>
        </p>
      </form>
    </Shell>
  );
}

function strength(pw: string): { score: number; label: string } {
  let s = 0;
  if (pw.length >= 10) s++;
  if (pw.length >= 14) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw) || /[^A-Za-z0-9]/.test(pw)) s++;
  return { score: s, label: ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][s] };
}

export function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'student', organisation: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agree, setAgree] = useState(false);
  const st = strength(form.password);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      await register({ ...form, organisation: form.organisation || undefined });
      nav('/app', { replace: true });
    } catch (err) {
      const ae = err as ApiError;
      setError(ae.message);
      const f: Record<string, string> = {};
      ae.details?.forEach((d) => (f[d.path] = d.message));
      setErrors(f);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Create your account" subtitle="Free for students, clinicians and researchers.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label="Full name" htmlFor="name" error={errors.name}>
          <Input id="name" autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} required />
        </Field>
        <Field label="Email" htmlFor="email" error={errors.email}>
          <Input id="email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} maxLength={254} required />
        </Field>
        <Field label="Password" htmlFor="password" error={errors.password} hint="At least 10 characters. A passphrase of several words works well.">
          <PasswordInput id="password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} autoComplete="new-password" invalid={!!errors.password} />
        </Field>
        {form.password && (
          <div aria-live="polite">
            <div className="flex gap-1" aria-hidden>
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={`h-1 flex-1 rounded ${i < st.score ? (st.score >= 3 ? 'bg-ok' : 'bg-warn') : 'bg-surface-3'}`} />
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">Strength: {st.label}</p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="I am a" htmlFor="role">
            <Select id="role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="student">Student</option>
              <option value="clinician">Clinician</option>
              <option value="researcher">Researcher</option>
            </Select>
          </Field>
          <Field label="Organisation" htmlFor="org" hint="Optional">
            <Input id="org" value={form.organisation} onChange={(e) => setForm({ ...form, organisation: e.target.value })} maxLength={120} />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-xs text-fg-2">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          I understand MedCare Twin is for education and research only and must not be used to make clinical decisions or with identifiable patient data.
        </label>
        <Button type="submit" loading={busy} disabled={!agree || !form.email || !form.password || !form.name}>
          Create account
        </Button>
        <p className="text-center text-sm text-muted">
          Already registered?{' '}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </Shell>
  );
}
