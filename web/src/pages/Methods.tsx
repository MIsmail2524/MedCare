import { useMemo } from 'react';
import { BookOpen, CheckCircle2, AlertTriangle } from 'lucide-react';
import { DRUGS, defaultPatient, makeRegimen, simulate } from '@medcare/engine';
import { Badge, Callout, Card, PageHeader } from '../components/ui';

const ref = defaultPatient();
function aucRatio(victim: string, perp: string | null, patient = ref, days = 14) {
  const mk = (id: string) => makeRegimen(id, { doses: Math.round((24 * days) / DRUGS.find((d) => d.id === id)!.defaultRegimen.intervalH) });
  const base = simulate({ patient: ref, regimens: [mk(victim)], metricsOnly: true }).metrics[victim].auc24;
  const test = simulate({ patient, regimens: perp ? [mk(victim), mk(perp)] : [mk(victim)], metricsOnly: true }).metrics[victim].auc24;
  return test / base;
}

const BENCHMARKS: { label: string; observed: string; lo: number; hi: number; run: () => number }[] = [
  { label: 'Atorvastatin + clarithromycin (AUC ratio)', observed: '≈ 4.5× (Amsden 2002)', lo: 3, hi: 7, run: () => aucRatio('atorvastatin', 'clarithromycin') },
  { label: 'Theophylline + ciprofloxacin', observed: '1.5–2.5× (product label)', lo: 1.4, hi: 3, run: () => aucRatio('theophylline', 'ciprofloxacin') },
  { label: 'Digoxin + amiodarone (steady state)', observed: '≈ 1.7–2× (label: halve dose)', lo: 1.5, hi: 2.3, run: () => aucRatio('digoxin', 'amiodarone', ref, 90) },
  { label: 'Lamotrigine + valproate', observed: '≈ 2× (half-life doubles)', lo: 1.7, hi: 2.8, run: () => aucRatio('lamotrigine', 'valproate') },
  { label: 'Midazolam (IV) + rifampicin', observed: '0.2–0.5× IV (much lower oral)', lo: 0.1, hi: 0.5, run: () => aucRatio('midazolam', 'rifampin') },
  { label: 'Metoprolol in CYP2D6 PM', observed: '4–5× (DPWG)', lo: 3, hi: 6, run: () => aucRatio('metoprolol', null, defaultPatient({ phenotypes: { CYP2D6: 'PM', CYP2C19: 'NM', CYP2C9: 'NM', CYP3A5: 'PM' } })) },
  { label: 'Warfarin S-clearance, CYP2C9 PM', observed: '≈ 2–4× exposure', lo: 2, hi: 4.5, run: () => aucRatio('warfarin', null, defaultPatient({ phenotypes: { CYP2D6: 'NM', CYP2C19: 'NM', CYP2C9: 'PM', CYP3A5: 'PM' } })) },
  { label: 'Tacrolimus CYP3A5 expresser (exposure)', observed: '≈ 0.5× (needs 1.5–2× dose)', lo: 0.4, hi: 0.7, run: () => aucRatio('tacrolimus', null, defaultPatient({ phenotypes: { CYP2D6: 'NM', CYP2C19: 'NM', CYP2C9: 'NM', CYP3A5: 'NM' } })) },
  { label: 'Vancomycin 1 g q12h AUC₂₄ (CrCl 100)', observed: '400–550 mg·h/L', lo: 380, hi: 600, run: () => simulate({ patient: ref, regimens: [makeRegimen('vancomycin', { doses: 8 })], metricsOnly: true }).metrics.vancomycin.auc24 },
  { label: 'Carbamazepine t½ after autoinduction (h)', observed: '12–17 h (initial ≈ 35 h)', lo: 10, hi: 20, run: () => simulate({ patient: ref, regimens: [makeRegimen('carbamazepine', { doses: 56 })], metricsOnly: true }).metrics.carbamazepine.halfLifeH },
];

const EQUATIONS = [
  ['Compartmental model', 'dA_gut/dt = −ka·A_gut;  dA_c/dt = ka·A_gut + R_inf − CL(t)·C − Q·(C − C_p);  dA_p/dt = Q·(C − C_p)'],
  ['Michaelis–Menten elimination', 'Elimination = Vmax·C / (Km + C)  (phenytoin)'],
  ['Clearance partition', 'CL = CL_renal·(CrCl/100) + CL_nonrenal·f_hepatic·(W/70)^0.75 · Σ fm_i·activity_i(t)'],
  ['Reversible inhibition', 'activity = E(t) / Π (1 + [I]/Ki),  Ki chosen so typical [I]ss gives 10% / 35% / 70% residual (strong / moderate / weak)'],
  ['Enzyme induction (turnover)', 'dE/dt = kdeg·(1 + Emax·[I]/(EC50+[I])) − kdeg·E,  kdeg = 0.019 h⁻¹ (t½ ≈ 36 h)'],
  ['Effect compartment & PD', 'dCe/dt = ke0·(C − Ce);  E = E0 + Emax·Ce^γ/(EC50^γ + Ce^γ)'],
  ['QTc', 'QTc = baseline + Σ ΔQTmax·C/(C + Cref) (+10 ms if K⁺ < 3.5)'],
  ['Renal function', 'Cockcroft–Gault (IBW/ABW rules), CKD-EPI 2021, bedside Schwartz < 18 y'],
  ['Body size', 'IBW (Devine), lean body weight (Janmahasatian), BSA (Mosteller), ABW = IBW + 0.4·(TBW − IBW)'],
  ['Population variability', 'θ_i = θ_pop·exp(η_i),  η ~ N(0, ω²),  ω = √ln(1 + CV²)'],
  ['Bayesian MAP', 'OFV = Σ (η/ω)² + Σ [((y − ŷ)/σ)² + 2·ln σ],  σ² = (0.15·ŷ)² + σ_add²  — minimised by Nelder–Mead'],
  ['First-in-human dose', 'HED = NOAEL·(Km_animal/37);  MRSD = HED / safety factor (FDA 2005)'],
  ['Anaesthesia', 'Marsh, Schnider (propofol) and Minto (remifentanil) 3-compartment models; BIS via Bouillon 2004 response surface'],
];

export default function Methods() {
  const rows = useMemo(() => BENCHMARKS.map((b) => ({ ...b, value: b.run() })), []);
  return (
    <div>
      <PageHeader icon={<BookOpen className="size-5" />} title="Models & validation" description="Every prediction in MedCare Twin comes from the explicit, inspectable equations below. Benchmarks are re-computed live in your browser." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Live validation against published observations" subtitle="Simulated value vs. reported clinical range">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted"><th className="pb-2 font-medium">Benchmark</th><th className="pb-2 font-medium">Reported</th><th className="pb-2 text-right font-medium">Model</th><th className="pb-2 pl-2 font-medium">Status</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const ok = r.value >= r.lo && r.value <= r.hi;
                return (
                  <tr key={r.label} className="border-t border-line">
                    <td className="py-2 pr-2">{r.label}</td>
                    <td className="py-2 pr-2 text-xs text-muted">{r.observed}</td>
                    <td className="py-2 text-right font-semibold tabular">{r.value >= 100 ? r.value.toFixed(0) : r.value.toFixed(2)}</td>
                    <td className="py-2 pl-2">{ok ? <Badge tone="ok"><CheckCircle2 className="size-3" aria-hidden />within</Badge> : <Badge tone="warn"><AlertTriangle className="size-3" aria-hidden />outside</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
        <Card title="Core equations">
          <dl className="space-y-3 text-sm">
            {EQUATIONS.map(([k, v]) => (
              <div key={k}><dt className="font-medium">{k}</dt><dd className="mt-0.5 rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-fg-2">{v}</dd></div>
            ))}
          </dl>
        </Card>
        <Card title="Assumptions & limitations">
          <ul className="list-disc space-y-1.5 pl-4 text-sm text-fg-2">
            <li>Parameters are population means for adults; paediatric maturation is approximated via renal function and allometry only.</li>
            <li>Total (bound + unbound) plasma concentrations are reported; protein-binding changes are flagged rather than modelled dynamically.</li>
            <li>Active metabolites are represented as activation-scaled exposure for prodrugs (codeine, clopidogrel), not as separate compartments.</li>
            <li>Interaction potency is calibrated to FDA strong/moderate/weak categories, scaled by the perpetrator’s concentration; gut-wall first-pass interactions are not separated from hepatic.</li>
            <li>Organ “risk” is a dimensionless index of exposure relative to toxic thresholds, intended for teaching — not a probability of injury.</li>
            <li>Anaesthesia haemodynamic and laryngoscopy-response models are simplified educational approximations.</li>
          </ul>
        </Card>
        <Card title="Key references">
          <ul className="list-disc space-y-1 pl-4 text-xs text-fg-2">
            <li>Rowland M, Tozer TN. Clinical Pharmacokinetics and Pharmacodynamics. 5th ed.</li>
            <li>Winter ME. Basic Clinical Pharmacokinetics. 6th ed.</li>
            <li>US FDA. Drug Development and Drug Interactions: Table of Substrates, Inhibitors and Inducers.</li>
            <li>US FDA. Estimating the Maximum Safe Starting Dose in Initial Clinical Trials (2005).</li>
            <li>Clinical Pharmacogenetics Implementation Consortium (CPIC) guidelines — warfarin, clopidogrel, opioids, SSRIs, PPIs, tacrolimus, NSAIDs, HLA.</li>
            <li>Rybak MJ et al. Vancomycin therapeutic monitoring consensus. Am J Health-Syst Pharm 2020.</li>
            <li>Inker LA et al. New creatinine-based equations to estimate GFR without race. NEJM 2021.</li>
            <li>Schnider TW et al. Anesthesiology 1998; Minto CF et al. Anesthesiology 1997; Marsh B et al. Br J Anaesth 1991; Bouillon TW et al. Anesthesiology 2004.</li>
            <li>Swain SM et al. Congestive heart failure in patients treated with doxorubicin. Cancer 2003.</li>
          </ul>
        </Card>
      </div>
      <div className="mt-6"><Callout tone="warn" title="Intended use">Education, training and early-stage research hypothesis generation. Not validated for, and must not be used for, individual patient care.</Callout></div>
    </div>
  );
}
