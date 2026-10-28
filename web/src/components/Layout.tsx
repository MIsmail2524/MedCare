import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity, BookOpen, Beaker, Brain, FlaskConical, GraduationCap, HeartPulse, LayoutDashboard, LogOut, Menu, Moon, Network,
  Pill, Search, Settings, Shield, Sun, Monitor, Syringe, Users, FolderOpen, X, Sigma, BrainCircuit, Landmark, Radar, Stethoscope,
} from 'lucide-react';
import { DRUGS } from '@medcare/engine';
import { useAuth } from '../lib/auth';
import { applyTheme, getTheme, type Theme } from '../lib/theme';
import { cx } from './ui';

const NAV = [
  { group: 'Overview', items: [{ to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true }] },
  {
    group: 'Digital twins',
    items: [
      { to: '/app/body', label: 'Body digital twin', icon: HeartPulse },
      { to: '/app/twins', label: 'Patient twins', icon: Users },
      { to: '/app/learning', label: 'AI learning lab', icon: BrainCircuit },
    ],
  },
  {
    group: 'Safety & regulation',
    items: [
      { to: '/app/regulatory', label: 'Regulatory twin', icon: Landmark },
      { to: '/app/signals', label: 'Post-market signals', icon: Radar },
      { to: '/app/adr', label: 'ADR detective', icon: Stethoscope },
    ],
  },
  {
    group: 'Simulate',
    items: [
      { to: '/app/simulate', label: 'Drug simulator', icon: Activity },
      { to: '/app/interactions', label: 'Interaction checker', icon: Network },
      { to: '/app/tdm', label: 'Precision dosing (TDM)', icon: Sigma },
      { to: '/app/trials', label: 'Virtual trials', icon: FlaskConical },
      { to: '/app/anesthesia', label: 'OR & anaesthesia', icon: Syringe },
      { to: '/app/discovery', label: 'Drug discovery', icon: Beaker },
    ],
  },
  {
    group: 'Learn',
    items: [
      { to: '/app/training', label: 'Clinical training', icon: GraduationCap },
      { to: '/app/library', label: 'Drug library', icon: Pill },
      { to: '/app/methods', label: 'Models & validation', icon: BookOpen },
    ],
  },
  {
    group: 'Workspace',
    items: [
      { to: '/app/experiments', label: 'Saved experiments', icon: FolderOpen },
      { to: '/app/settings', label: 'Settings & security', icon: Settings },
    ],
  },
];

function ThemeToggle() {
  const [t, setT] = useState<Theme>(getTheme());
  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  const Icon = t === 'light' ? Sun : t === 'dark' ? Moon : Monitor;
  return (
    <button
      onClick={() => {
        const n = next[t];
        setT(n);
        applyTheme(n);
      }}
      className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg"
      aria-label={`Theme: ${t}. Switch to ${next[t]}`}
      title={`Theme: ${t}`}
    >
      <Icon className="size-4" />
    </button>
  );
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const nav = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const items = useMemo(() => {
    const pages = NAV.flatMap((g) => g.items.map((i) => ({ kind: 'Page', label: i.label, to: i.to })));
    const drugs = DRUGS.map((d) => ({ kind: 'Drug', label: `${d.name} — ${d.drugClass}`, to: `/app/library?drug=${d.id}` }));
    const sims = DRUGS.map((d) => ({ kind: 'Simulate', label: `Simulate ${d.name}`, to: `/app/simulate?drug=${d.id}` }));
    const all = [...pages, ...drugs, ...sims];
    const s = q.trim().toLowerCase();
    return (s ? all.filter((i) => i.label.toLowerCase().includes(s)) : pages).slice(0, 12);
  }, [q]);
  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);
  if (!open) return null;
  const go = (to: string) => {
    nav(to);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="size-4 text-muted" aria-hidden />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === 'Enter' && items[sel]) go(items[sel].to);
              else if (e.key === 'Escape') onClose();
            }}
            placeholder="Search pages, drugs, actions…"
            aria-label="Search"
            aria-controls="cmd-list"
            aria-activedescendant={items[sel] ? `cmd-${sel}` : undefined}
            className="h-12 flex-1 bg-transparent text-sm outline-none"
          />
          <kbd className="rounded border border-line px-1.5 text-[10px] text-muted">Esc</kbd>
        </div>
        <ul id="cmd-list" role="listbox" className="max-h-80 overflow-y-auto p-2">
          {items.map((i, idx) => (
            <li
              id={`cmd-${idx}`}
              key={i.kind + i.to}
              role="option"
              aria-selected={idx === sel}
              onMouseEnter={() => setSel(idx)}
              onClick={() => go(i.to)}
              className={cx('flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm', idx === sel && 'bg-primary-soft text-primary')}
            >
              <span>{i.label}</span>
              <span className="text-[11px] text-muted">{i.kind}</span>
            </li>
          ))}
          {!items.length && <li className="px-3 py-6 text-center text-sm text-muted">No results</li>}
        </ul>
      </div>
    </div>
  );
}

export function AppLayout() {
  const { user, logout } = useAuth();
  const [mobile, setMobile] = useState(false);
  const [cmd, setCmd] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => setMobile(false), [loc.pathname]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmd((c) => !c);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col gap-5 overflow-y-auto px-3 py-4">
      <Link to="/app" className="flex items-center gap-2 px-2">
        <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-fg">
          <HeartPulse className="size-4" aria-hidden />
        </span>
        <span className="font-semibold tracking-tight">
          MedCare <span className="text-primary">Twin</span>
        </span>
      </Link>
      <button onClick={() => setCmd(true)} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-left text-sm text-muted hover:border-line-strong">
        <Search className="size-4" aria-hidden />
        <span className="flex-1">Search…</span>
        <kbd className="rounded border border-line px-1 text-[10px]">Ctrl K</kbd>
      </button>
      {NAV.map((g) => (
        <div key={g.group}>
          <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{g.group}</p>
          <ul className="flex flex-col gap-0.5">
            {g.items.map((i) => (
              <li key={i.to}>
                <NavLink
                  to={i.to}
                  end={'end' in i}
                  className={({ isActive }) =>
                    cx('flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors', isActive ? 'bg-primary-soft font-medium text-primary' : 'text-fg-2 hover:bg-surface-2 hover:text-fg')
                  }
                >
                  <i.icon className="size-4 shrink-0" aria-hidden />
                  {i.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {user?.role === 'admin' && (
        <NavLink to="/app/admin" className={({ isActive }) => cx('flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm', isActive ? 'bg-primary-soft text-primary' : 'text-fg-2 hover:bg-surface-2')}>
          <Shield className="size-4" aria-hidden /> Administration
        </NavLink>
      )}
      <div className="mt-auto rounded-xl bg-surface-2 p-3 text-[11px] leading-relaxed text-muted">
        <Brain className="mb-1 size-4 text-primary" aria-hidden />
        For education and research only. Not a medical device. Do not use for clinical decisions.
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-line bg-surface lg:block print:hidden">{sidebar}</aside>
      {mobile && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobile(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-surface shadow-xl">
            <button className="absolute right-3 top-4 rounded-md p-1 text-muted" onClick={() => setMobile(false)} aria-label="Close menu">
              <X className="size-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="lg:pl-64 print:pl-0">
        <header className="sticky top-0 z-40 flex h-14 print:hidden items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur">
          <button className="rounded-md p-1.5 text-muted lg:hidden" onClick={() => setMobile(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <div className="flex-1" />
          {user?.isDemo && <span className="hidden rounded-full bg-warn-soft px-2.5 py-1 text-xs font-medium text-warn sm:inline">Shared demo account</span>}
          <ThemeToggle />
          <div className="flex items-center gap-2">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium leading-tight">{user?.name}</p>
              <p className="text-[11px] capitalize text-muted">{user?.role}</p>
            </div>
            <span className="grid size-8 place-items-center rounded-full bg-primary-soft text-sm font-semibold text-primary" aria-hidden>
              {user?.name?.[0]?.toUpperCase()}
            </span>
            <button
              onClick={async () => {
                await logout();
                nav('/login');
              }}
              className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg"
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={cmd} onClose={() => setCmd(false)} />
    </div>
  );
}
