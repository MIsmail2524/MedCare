import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, Beaker, BrainCircuit, Dna, Landmark, FlaskConical, GraduationCap, HeartPulse, History, Lock, Network, Sigma, Syringe, Users, ArrowRight, CheckCircle2,
} from 'lucide-react';
import { DRUGS, defaultPatient, makeRegimen, simulate } from '@medcare/engine';
import { useAuth } from '../lib/auth';
import { TimeChart } from '../components/charts';
import { fmt } from '../lib/format';

const FEATURES = [
  { icon: Landmark, title: 'Regulatory twin', body: 'Organ-liability predictions learned from FDA labels and FAERS, combined with simulated exposure in special populations, produce a draft label and evidence gaps for new or approved medicines.' },
  { icon: HeartPulse, title: '3D body digital twin', body: 'Give a medicine and watch it travel through a holographic human body — absorption, first-pass, circulation, tissues, metabolism, excretion — with organs lighting up and side effects appearing where they happen.' },
  { icon: BrainCircuit, title: 'Learns from every patient', body: 'Recorded real outcomes refine pharmacokinetic priors and organ side-effect models, and reinforce a reinforcement-learning dosing agent for future patients.' },
  { icon: Users, title: 'Patient digital twins', body: 'Age, size, renal & hepatic function, pregnancy, genotype (CYP2D6/2C19/2C9/3A5, VKORC1, HLA), conditions and allergies — all feeding validated physiological equations.' },
  { icon: Activity, title: 'Multi-drug PK/PD simulator', body: 'Concentration–time, effect-site response, QTc and organ-level load for up to six concurrent medicines, with dynamic enzyme inhibition and induction.' },
  { icon: History, title: 'Retrospective analysis', body: 'Reconstructs what past medicines and surgeries already did: residual levels, enzyme carry-over, cumulative cardiotoxic or nephrotoxic dose and altered absorption.' },
  { icon: Sigma, title: 'Bayesian precision dosing', body: 'Fit measured drug levels with MAP estimation (as in MIPD tools) to individualise clearance and recommend the next dose.' },
  { icon: FlaskConical, title: 'Virtual clinical trials', body: 'Simulate hundreds of virtual patients with realistic covariates and ancestry-specific genotype frequencies; compare arms by target attainment and toxicity.' },
  { icon: Syringe, title: 'OR & anaesthesia simulator', body: 'Marsh/Schnider propofol and Minto remifentanil TCI with BIS, haemodynamics and scored surgical scenarios for anaesthesia training.' },
  { icon: Beaker, title: 'Drug discovery sandbox', body: 'Drug-likeness, BCS class, FDA first-in-human starting dose (HED/MRSD), allometric scaling and SAD/MAD cohort simulation for new compounds.' },
  { icon: Network, title: 'Interaction & PGx checker', body: 'Curated major interactions, mechanism-based CYP/P-gp effects, QT stacking, serotonergic, bleeding and nephrotoxic combinations, CPIC guidance.' },
  { icon: GraduationCap, title: 'Case-based training', body: 'Interactive clinical cases linked to live simulations, with explanations and progress tracking for students and residents.' },
];

export default function Landing() {
  const { user } = useAuth();
  const [crcl, setCrcl] = useState(100);
  const demo = useMemo(() => {
    const scr = Math.max(0.3, (((140 - 40) * 70) / (72 * crcl)));
    const p = defaultPatient({ scr });
    return simulate({ patient: p, regimens: [makeRegimen('vancomycin', { doses: 8 })] });
  }, [crcl]);
  const m = demo.metrics.vancomycin;
  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-fg"><HeartPulse className="size-4" aria-hidden /></span>
            MedCare <span className="text-primary">Twin</span>
          </Link>
          <nav className="flex items-center gap-2 text-sm" aria-label="Site">
            <a href="#features" className="hidden px-3 py-2 text-fg-2 hover:text-fg sm:inline">Features</a>
            <a href="#science" className="hidden px-3 py-2 text-fg-2 hover:text-fg sm:inline">Science</a>
            <a href="#security" className="hidden px-3 py-2 text-fg-2 hover:text-fg md:inline">Security</a>
            {user ? (
              <Link to="/app" className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-fg hover:bg-primary-hover">Open workspace</Link>
            ) : (
              <>
                <Link to="/login" className="px-3 py-2 text-fg-2 hover:text-fg">Sign in</Link>
                <Link to="/register" className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-fg hover:bg-primary-hover">Get started</Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 lg:grid-cols-[1.05fr_1fr] lg:py-24">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-primary-soft px-3 py-1 text-xs font-medium text-primary">
              <Dna className="size-3.5" aria-hidden /> Physiology-based pharmacology digital twin
            </p>
            <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
              Simulate how medicines move through — and act on — <span className="text-primary">each patient’s body</span>.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-fg-2">
              MedCare Twin lets doctors, surgeons, students and drug developers rehearse prescribing, test new compounds and understand what previous medicines and operations have already changed — safely, on a virtual patient.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to={user ? '/app' : '/register'} className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-3 font-medium text-primary-fg hover:bg-primary-hover">
                {user ? 'Open workspace' : 'Create free account'} <ArrowRight className="size-4" aria-hidden />
              </Link>
              <Link to="/login" className="rounded-lg border border-line-strong bg-surface px-5 py-3 font-medium hover:bg-surface-2">Try the demo</Link>
            </div>
            <ul className="mt-8 grid gap-2 text-sm text-fg-2 sm:grid-cols-2">
              {[`${DRUGS.length} drugs with literature PK/PD`, 'CPIC pharmacogenomics', 'Dynamic CYP induction & inhibition', 'Bayesian TDM (MAP)'].map((t) => (
                <li key={t} className="flex items-center gap-2"><CheckCircle2 className="size-4 text-ok" aria-hidden />{t}</li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow)]">
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-semibold">Live: vancomycin 1 g q12h</p>
              <p className="text-xs text-muted">AUC target 400–600 mg·h/L</p>
            </div>
            <TimeChart
              ariaLabel="Vancomycin concentration over four days"
              t={demo.t}
              unit="mg/L"
              height={220}
              series={[{ def: { key: 'v', label: 'Vancomycin', color: 'var(--s1)' }, values: demo.series.vancomycin.conc }]}
            />
            <label htmlFor="crcl" className="mt-3 flex justify-between text-sm">
              <span>Kidney function (CrCl)</span>
              <span className="font-semibold tabular">{crcl} mL/min</span>
            </label>
            <input id="crcl" type="range" min={15} max={140} step={5} value={crcl} onChange={(e) => setCrcl(Number(e.target.value))} className="w-full" />
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-surface-2 p-2"><p className="text-[11px] text-muted">AUC₂₄</p><p className={`font-semibold tabular ${m.auc24 > 600 ? 'text-danger' : m.auc24 < 400 ? 'text-warn' : 'text-ok'}`}>{fmt(m.auc24)}</p></div>
              <div className="rounded-lg bg-surface-2 p-2"><p className="text-[11px] text-muted">Trough</p><p className="font-semibold tabular">{fmt(m.troughLast)} mg/L</p></div>
              <div className="rounded-lg bg-surface-2 p-2"><p className="text-[11px] text-muted">Half-life</p><p className="font-semibold tabular">{fmt(m.halfLifeH)} h</p></div>
            </div>
            <p className="mt-3 text-xs text-muted">Drag the slider: as kidney function falls, clearance drops and the drug accumulates into the nephrotoxic range.</p>
          </div>
        </section>

        <section id="features" className="border-t border-line bg-surface py-16">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="text-3xl font-semibold tracking-tight">One twin, every question about a medicine</h2>
            <p className="mt-2 max-w-2xl text-fg-2">Inspired by the capabilities of professional PBPK platforms, model-informed precision dosing tools and anaesthesia simulators — packaged for learning and early research.</p>
            <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <div key={f.title} className="rounded-2xl border border-line bg-bg p-5">
                  <f.icon className="size-6 text-primary" aria-hidden />
                  <h3 className="mt-3 font-semibold">{f.title}</h3>
                  <p className="mt-1.5 text-sm text-fg-2">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="science" className="mx-auto max-w-6xl px-4 py-16">
          <div className="grid gap-10 lg:grid-cols-2">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight">Transparent, mechanistic science</h2>
              <p className="mt-3 text-fg-2">Every prediction comes from an explicit equation you can inspect on the Models & validation page — no black box.</p>
              <ul className="mt-6 space-y-3 text-sm text-fg-2">
                <li><strong className="text-fg">Compartmental ODEs</strong> solved with 4th-order Runge–Kutta, linear and Michaelis–Menten elimination.</li>
                <li><strong className="text-fg">Covariates:</strong> Cockcroft–Gault, CKD-EPI 2021, Schwartz, allometric scaling, Child–Pugh, pregnancy.</li>
                <li><strong className="text-fg">Interactions:</strong> concentration-dependent reversible inhibition and turnover-based enzyme induction with realistic onset/offset.</li>
                <li><strong className="text-fg">Validation:</strong> automated tests check analytic solutions and published interaction magnitudes (e.g. clarithromycin–atorvastatin, ciprofloxacin–theophylline).</li>
              </ul>
            </div>
            <div id="security" className="rounded-2xl border border-line bg-surface p-6">
              <Lock className="size-6 text-primary" aria-hidden />
              <h3 className="mt-3 text-xl font-semibold">Security by design</h3>
              <ul className="mt-4 grid gap-2 text-sm text-fg-2">
                {['scrypt password hashing & lockout', 'HttpOnly, SameSite=Strict, __Host- session cookies', 'CSRF tokens + Origin verification', 'TOTP two-factor authentication (encrypted at rest)', 'Strict Content-Security-Policy & HSTS', 'Role-based access, per-user data isolation', 'Full audit log for administrators', 'Input validation on every endpoint'].map((t) => (
                  <li key={t} className="flex items-center gap-2"><CheckCircle2 className="size-4 text-ok" aria-hidden />{t}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-8 text-xs text-muted">
          <p className="font-medium text-fg-2">Important</p>
          <p className="mt-1 max-w-3xl">
            MedCare Twin is an educational and research simulator. Parameters are population averages from published literature; real patients vary. It is not a medical device, has not been cleared by any regulator, and must not be used to diagnose, treat or make prescribing decisions. Do not enter identifiable patient information.
          </p>
          <p className="mt-4">© {new Date().getFullYear()} MedCare Twin</p>
        </div>
      </footer>
    </div>
  );
}
