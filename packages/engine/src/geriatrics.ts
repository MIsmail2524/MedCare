import { getDrug } from './drugs.js';
import { derivePhysiology } from './physiology.js';
import { evaluateAlerts } from './interactions.js';
import { base64ToBytes, similarity, type KBDrug, type SafetyKB } from './safety.js';
import type { Patient } from './types.js';

// Geriatric twin: (1) a data-driven age-risk signal learned from FAERS age distributions — which
// drugs are over-represented in older adults — with a structure/class model that predicts it for
// any drug; (2) a deprescribing optimiser that removes or swaps medicines to minimise the
// combined anticholinergic, sedative, fall, bleeding, kidney, QT and interaction burden.

export type AgeBands = Record<'0-1' | '2-11' | '12-17' | '18-44' | '45-64' | '65-74' | '75+', number>;

export interface AgeSignal {
  name: string;
  elderlyRatio: number; // share of reports aged ≥ 65 relative to all drugs
  paediatricRatio: number; // share aged < 18 relative to all drugs
  reports: number;
}

export function ageSignals(ages: Record<string, AgeBands>): AgeSignal[] {
  const pool = { e: 0, p: 0, t: 0 };
  for (const b of Object.values(ages)) {
    const t = Object.values(b).reduce((s, x) => s + x, 0);
    pool.t += t;
    pool.e += b['65-74'] + b['75+'];
    pool.p += b['0-1'] + b['2-11'] + b['12-17'];
  }
  return Object.entries(ages)
    .map(([name, b]) => {
      const t = Object.values(b).reduce((s, x) => s + x, 0);
      return {
        name,
        reports: t,
        elderlyRatio: t ? ((b['65-74'] + b['75+']) / t) / (pool.e / pool.t) : 0,
        paediatricRatio: t ? ((b['0-1'] + b['2-11'] + b['12-17']) / t) / (pool.p / pool.t) : 0,
      };
    })
    .filter((x) => x.reports >= 50);
}

export interface AgeModelReport {
  n: number;
  spearmanElderly: number;
  spearmanPaediatric: number;
  predictions: { name: string; observed: number; predicted: number }[];
}

function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]) => {
    const o = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array(v.length);
    o.forEach(([, i], k) => (r[i] = k));
    return r as number[];
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const ma = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - ma);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - ma) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
}

/** Predict a drug's log age-ratio from its nearest structural/pharmacological neighbours. */
export function predictAgeRatio(target: Pick<KBDrug, 'fp' | 'classes' | 'name'>, kb: SafetyKB, sig: Map<string, AgeSignal>, which: 'elderly' | 'paediatric', k = 8): number {
  const cache = new Map<string, Uint8Array>();
  const neigh = kb.drugs
    .filter((d) => d.name !== target.name && sig.has(d.name))
    .map((d) => similarity({ fp: target.fp ? base64ToBytes(target.fp) : null, classes: target.classes }, d, cache))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
  let num = 0, den = 0.3;
  for (const n of neigh) {
    const s = sig.get(n.drug.name)!;
    const w = n.similarity ** 3;
    num += w * Math.log(Math.max(which === 'elderly' ? s.elderlyRatio : s.paediatricRatio, 0.01));
    den += w;
  }
  return Math.exp(num / den);
}

/** Leave-one-out validation of the age-risk model (Spearman rank correlation). */
export function validateAgeModel(kb: SafetyKB, ages: Record<string, AgeBands>): AgeModelReport {
  const sigs = ageSignals(ages);
  const sig = new Map(sigs.map((s) => [s.name, s]));
  const drugs = kb.drugs.filter((d) => sig.has(d.name));
  const obsE: number[] = [], preE: number[] = [], obsP: number[] = [], preP: number[] = [];
  const predictions: AgeModelReport['predictions'] = [];
  for (const d of drugs) {
    const pe = predictAgeRatio(d, kb, sig, 'elderly');
    const pp = predictAgeRatio(d, kb, sig, 'paediatric');
    obsE.push(sig.get(d.name)!.elderlyRatio);
    preE.push(pe);
    obsP.push(sig.get(d.name)!.paediatricRatio);
    preP.push(pp);
    predictions.push({ name: d.genericName, observed: sig.get(d.name)!.elderlyRatio, predicted: pe });
  }
  return { n: drugs.length, spearmanElderly: spearman(obsE, preE), spearmanPaediatric: spearman(obsP, preP), predictions };
}

// --- Deprescribing ---------------------------------------------------------

/** Anticholinergic Cognitive Burden scale scores (Boustani 2008; 2012 update) for twin drugs. */
export const ACB: Record<string, number> = {
  haloperidol: 1, metoprolol: 1, furosemide: 1, warfarin: 1, codeine: 1, morphine: 1, fentanyl: 1, digoxin: 1, carbamazepine: 2, methadone: 1,
  fluoxetine: 1, citalopram: 1, lithium: 1, midazolam: 1, theophylline: 1, valproate: 1, prednisone: 1, ranitidine: 1,
};
const SEDATIVE = new Set(['midazolam', 'morphine', 'codeine', 'fentanyl', 'methadone', 'haloperidol', 'carbamazepine', 'valproate', 'phenytoin', 'lamotrigine']);
const FALL_RISK = new Set(['midazolam', 'morphine', 'codeine', 'fentanyl', 'methadone', 'haloperidol', 'fluoxetine', 'citalopram', 'metoprolol', 'amlodipine', 'lisinopril', 'furosemide', 'carbamazepine', 'phenytoin', 'lithium']);

export interface BurdenBreakdown {
  total: number;
  anticholinergic: number;
  sedative: number;
  fallRisk: number;
  interactions: number;
  renalHepatic: number;
  ageSignal: number;
}

export function medicationBurden(patient: Patient, drugIds: string[], ageSig?: Map<string, AgeSignal>): BurdenBreakdown {
  const phys = derivePhysiology(patient);
  const alerts = evaluateAlerts(patient, phys, drugIds);
  const anticholinergic = drugIds.reduce((s, id) => s + (ACB[id] ?? 0), 0);
  const sedative = drugIds.filter((id) => SEDATIVE.has(id)).length;
  const fallRisk = drugIds.filter((id) => FALL_RISK.has(id)).length;
  const sev = { contraindicated: 4, major: 2.5, moderate: 1, info: 0.2 };
  const interactions = alerts.filter((a) => a.category === 'interaction' || a.category === 'qt').reduce((s, a) => s + sev[a.severity], 0);
  const renalHepatic = alerts.filter((a) => a.category === 'renal' || a.category === 'hepatic').reduce((s, a) => s + sev[a.severity], 0);
  const ageSignal = drugIds.reduce((s, id) => s + Math.max(0, Math.log2(ageSig?.get(id)?.elderlyRatio ?? 1)), 0);
  const total = 1.5 * anticholinergic + 1.5 * Math.max(0, sedative - 0) + 1 * fallRisk + interactions + renalHepatic + 0.8 * ageSignal;
  return { total, anticholinergic, sedative, fallRisk, interactions, renalHepatic, ageSignal };
}

export interface DeprescribingStep {
  remove: string;
  reason: string;
  before: number;
  after: number;
}

/** Greedy deprescribing: repeatedly drop the non-essential drug that most reduces the burden score. */
export function deprescribe(patient: Patient, drugIds: string[], essential: string[] = [], ageSig?: Map<string, AgeSignal>, maxSteps = 4): { steps: DeprescribingStep[]; final: string[]; baseline: BurdenBreakdown; finalBurden: BurdenBreakdown } {
  let current = [...drugIds];
  const baseline = medicationBurden(patient, current, ageSig);
  const steps: DeprescribingStep[] = [];
  for (let k = 0; k < maxSteps; k++) {
    const before = medicationBurden(patient, current, ageSig).total;
    let best: { id: string; after: number } | null = null;
    for (const id of current) {
      if (essential.includes(id)) continue;
      const after = medicationBurden(patient, current.filter((x) => x !== id), ageSig).total;
      if (!best || after < best.after) best = { id, after };
    }
    if (!best || before - best.after < 0.75) break;
    const d = getDrug(best.id);
    const reasons = [ACB[best.id] ? `anticholinergic (ACB ${ACB[best.id]})` : '', SEDATIVE.has(best.id) ? 'sedative' : '', FALL_RISK.has(best.id) ? 'fall-risk' : '', d.flags.length ? d.flags.join('/') : ''].filter(Boolean);
    steps.push({ remove: best.id, reason: reasons.join(', ') || 'interaction / organ-function burden', before, after: best.after });
    current = current.filter((x) => x !== best!.id);
  }
  return { steps, final: current, baseline, finalBurden: medicationBurden(patient, current, ageSig) };
}
