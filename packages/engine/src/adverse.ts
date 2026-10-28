import { getDrug } from './drugs.js';
import { ORGANS, referenceConcentration } from './pk.js';
import type { SimulationResult } from './pk.js';
import type { Drug, ExposureBasis, Organ, Patient, Physiology } from './types.js';

// Side-effect prediction: a mechanistic prior (exposure relative to toxic threshold plus patient
// risk factors) expressed as a per-organ logistic model whose weights are refined from recorded
// clinical outcomes (online, L2-regularised toward the prior so a few cases cannot dominate).

export const AE_FEATURES = ['bias', 'log exposure ratio', 'age ≥ 65', 'renal impairment', 'hepatic impairment', 'co-medication burden', 'pharmacogenomic deviation', 'female sex'] as const;
export const AE_PRIOR_WEIGHTS = [-1.0, 2.5, 0.3, 0.6, 0.6, 0.4, 0.5, 0.1];

export const ORGAN_SYMPTOMS: Record<Organ, string[]> = {
  brain: ['Confusion or drowsiness', 'Dizziness, unsteady gait', 'Tremor', 'Seizures at high levels'],
  thyroid: ['Fatigue, weight change', 'Cold or heat intolerance', 'Abnormal TSH'],
  heart: ['Palpitations', 'Dizziness or fainting', 'Slow or irregular pulse', 'QT prolongation on ECG'],
  lungs: ['Slow or shallow breathing', 'Breathlessness', 'Low oxygen saturation', 'Dry cough'],
  liver: ['Rising ALT/AST', 'Nausea, right upper abdominal pain', 'Jaundice, dark urine'],
  pancreas: ['Severe upper abdominal pain', 'Raised lipase', 'High blood glucose'],
  gi: ['Nausea or vomiting', 'Abdominal pain', 'Black stools / GI bleeding', 'Diarrhoea or constipation'],
  kidneys: ['Rising serum creatinine', 'Reduced urine output', 'Fluid retention', 'Electrolyte disturbance'],
  blood: ['Easy bruising or bleeding', 'Low blood counts / infection risk', 'Anaemia, fatigue'],
  muscle: ['Muscle pain or weakness', 'Raised CK', 'Tendon pain'],
  skin: ['Rash or itching', 'Blistering / mucosal lesions (SJS/TEN)', 'Swelling (angioedema / oedema)'],
};

export interface AEModel {
  version: number;
  weights: Record<Organ, number[]>;
  samples: Record<Organ, number>;
  updatedAt: string | null;
}

export function defaultAEModel(): AEModel {
  return {
    version: 1,
    weights: Object.fromEntries(ORGANS.map((o) => [o, AE_PRIOR_WEIGHTS.slice()])) as Record<Organ, number[]>,
    samples: Object.fromEntries(ORGANS.map((o) => [o, 0])) as Record<Organ, number>,
    updatedAt: null,
  };
}

export interface SideEffectPrediction {
  id: string;
  drugId: string;
  organ: Organ;
  name: string;
  mechanism: string;
  symptoms: string[];
  probability: number;
  peakH: number;
  onsetH: number | null;
  severity: 'mild' | 'moderate' | 'severe';
  drivers: { feature: string; contribution: number }[];
  timeline: number[];
  learned: boolean;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function pgxDeviation(drug: Drug, phys: Physiology): number {
  const pathway = drug.prodrug?.pathway ?? drug.metabolism.slice().sort((a, b) => b.fm - a.fm)[0]?.pathway;
  if (!pathway || pathway === 'CYP3A5') return 0;
  const act = phys.enzymeActivity[pathway];
  return Math.min(Math.abs(Math.log(Math.max(act, 0.05))), 3) / 1.5;
}

/** Feature vector for a drug–organ pair given an exposure ratio (exposure / toxic threshold). */
export function aeFeatures(drug: Drug, organ: Organ, ratio: number, patient: Patient, phys: Physiology, otherDrugs: Drug[]): number[] {
  const burden = otherDrugs.filter((d) => d.id !== drug.id && (d.organs.some((o) => o.organ === organ && o.kind === 'adverse') || d.flags.some((f) => drug.flags.includes(f)))).length;
  return [
    1,
    Math.log(Math.max(ratio, 1e-3)),
    patient.age >= 65 ? 1 : 0,
    Math.max(0, (60 - phys.crcl) / 60),
    Math.max(0, 1 - phys.hepaticFactor),
    Math.min(burden, 4) / 2,
    pgxDeviation(drug, phys),
    patient.sex === 'female' ? 1 : 0,
  ];
}

/** Reactions that are immune/idiosyncratic or rate-related rather than concentration-driven. */
const IDIOSYNCRATIC = /SJS|TEN|rash|infusion reaction|angioedema|heparin-induced|interstitial nephritis|\(rare\)|DRESS|agranulocytosis/i;

function hlaRisk(drug: Drug, patient: Patient): number {
  if ((drug.id === 'carbamazepine' || drug.id === 'phenytoin') && patient.hla.B1502) return 4;
  return 0;
}

/** Exposure series matched to the threshold's basis (rolling trough / average / AUC₂₄ / peak). */
function exposureSeries(sim: SimulationResult, conc: number[], basis: ExposureBasis, tau: number): number[] {
  const t = sim.t;
  const out = new Array(conc.length).fill(0);
  if (basis === 'peak') return conc.slice();
  let lo = 0;
  let area = 0;
  for (let k = 0; k < conc.length; k++) {
    if (k > 0) area += 0.5 * (conc[k] + conc[k - 1]) * (t[k] - t[k - 1]);
    const win = basis === 'auc24' ? 24 : tau;
    while (lo < k && t[k] - t[lo + 1] >= win) {
      area -= 0.5 * (conc[lo + 1] + conc[lo]) * (t[lo + 1] - t[lo]);
      lo++;
    }
    const span = t[k] - t[lo];
    // Before a full window has elapsed, assume the pre-simulation level equals the starting
    // concentration (carry-over from history; zero for a first dose).
    const missing = Math.max(0, win - span);
    if (basis === 'auc24') out[k] = area + conc[0] * missing;
    else if (basis === 'average') out[k] = (area + conc[0] * missing) / win;
    else {
      let m = missing > 0 ? conc[0] : Infinity;
      for (let j = lo; j <= k; j++) m = Math.min(m, conc[j]);
      out[k] = m;
    }
  }
  return out;
}

function headline(note: string): string {
  return note.split(/[—(;,]/)[0].trim();
}

/** Predict the time course of organ-level side effects for every drug in a simulation. */
export function predictSideEffects(sim: SimulationResult, patient: Patient, model: AEModel = defaultAEModel(), opts: { cumulativeRatios?: Record<string, number> } = {}): SideEffectPrediction[] {
  const phys = sim.physiology;
  const drugs = sim.drugIds.map(getDrug);
  const out: SideEffectPrediction[] = [];
  for (const d of drugs) {
    const s = sim.series[d.id];
    if (!s) continue;
    const factor = d.display.factor;
    const basis: ExposureBasis = d.toxic?.basis ?? 'peak';
    // Threshold in display units for the chosen basis (AUC stays as AUC).
    const toxValue = d.toxic ? d.toxic.value : referenceConcentration(d) * factor * 4;
    const tau = sim.metrics[d.id]?.intervalH ?? 24;
    const exposure = exposureSeries(sim, s.active ?? s.conc, basis, tau);
    const adverse = d.organs.filter((o) => o.kind === 'adverse');
    for (const a of adverse) {
      const w = model.weights[a.organ];
      const idio = IDIOSYNCRATIC.test(a.note);
      const conc = exposure;
      let peak = 0;
      let peakH = 0;
      let onsetH: number | null = null;
      let peakX: number[] = [];
      const cumRatio = a.organ === d.cumulativeLimit?.organ ? opts.cumulativeRatios?.[d.id] ?? 0 : 0;
      const timeline = conc.map((c, k) => {
        const ratio = idio ? (sim.t[k] > 0 ? 1 : 1e-3) : Math.max(c / toxValue, cumRatio);
        const x = aeFeatures(d, a.organ, ratio, patient, phys, drugs);
        const shift = idio ? -3 + (a.organ === 'skin' ? hlaRisk(d, patient) : 0) : 0;
        const p = sigmoid(x.reduce((acc, xi, i) => acc + xi * w[i], 0) + shift);
        if (p > peak) {
          peak = p;
          peakH = sim.t[k];
          peakX = x;
        }
        if (onsetH === null && p >= 0.2) onsetH = sim.t[k];
        return p;
      });
      if (peak < 0.03) continue;
      const drivers = peakX
        .map((xi, i) => ({ feature: AE_FEATURES[i], contribution: xi * w[i] }))
        .filter((x) => x.feature !== 'bias' && Math.abs(x.contribution) > 0.05)
        .sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution));
      out.push({
        id: `${d.id}:${a.organ}:${headline(a.note)}`,
        drugId: d.id,
        organ: a.organ,
        name: headline(a.note),
        mechanism: idio ? `${a.note} (idiosyncratic — not dose-predictable)` : a.note,
        symptoms: ORGAN_SYMPTOMS[a.organ],
        probability: peak,
        peakH,
        onsetH,
        severity: peak >= 0.5 ? 'severe' : peak >= 0.2 ? 'moderate' : 'mild',
        drivers,
        timeline,
        learned: model.samples[a.organ] > 0,
      });
    }
    // Torsades de pointes from QT prolongation (uses whole-regimen QTc)
    if (d.qt.risk === 'known' && sim.qtc.length) {
      const w = model.weights.heart;
      let peak = 0;
      let peakH = 0;
      let onsetH: number | null = null;
      let peakX: number[] = [];
      const timeline = sim.qtc.map((q, k) => {
        const ratio = Math.max(q - 400, 1) / 100;
        const x = aeFeatures(d, 'heart', ratio, patient, phys, drugs);
        x[2] = patient.potassium < 3.5 ? 1 : x[2];
        const p = sigmoid(x.reduce((acc, xi, i) => acc + xi * w[i], 0) - 1.2);
        if (p > peak) {
          peak = p;
          peakH = sim.t[k];
          peakX = x;
        }
        if (onsetH === null && p >= 0.2) onsetH = sim.t[k];
        return p;
      });
      if (peak >= 0.03) {
        out.push({
          id: `${d.id}:heart:torsades`,
          drugId: d.id,
          organ: 'heart',
          name: 'QT prolongation / torsades risk',
          mechanism: 'hERG (IKr) channel block delays ventricular repolarisation',
          symptoms: ORGAN_SYMPTOMS.heart,
          probability: peak,
          peakH,
          onsetH,
          severity: peak >= 0.5 ? 'severe' : peak >= 0.2 ? 'moderate' : 'mild',
          drivers: peakX.map((xi, i) => ({ feature: i === 1 ? 'log QTc excess' : AE_FEATURES[i], contribution: xi * w[i] })).filter((x) => x.feature !== 'bias' && Math.abs(x.contribution) > 0.05),
          timeline,
          learned: model.samples.heart > 0,
        });
      }
    }
  }
  // collapse duplicates (same drug+organ) keeping the highest
  const best = new Map<string, SideEffectPrediction>();
  for (const p of out) {
    const k = `${p.drugId}:${p.organ}:${p.name}`;
    if (!best.has(k) || best.get(k)!.probability < p.probability) best.set(k, p);
  }
  return Array.from(best.values()).sort((a, b) => b.probability - a.probability);
}

export interface AETrainingSample {
  organ: Organ;
  features: number[];
  label: 0 | 1;
  weight?: number;
}

/** One regularised online-logistic-regression update per sample (MAP toward the mechanistic prior). */
export function updateAEModel(model: AEModel, samples: AETrainingSample[], lr = 0.15, lambda = 0.05): AEModel {
  const next: AEModel = {
    version: model.version + 1,
    weights: Object.fromEntries(ORGANS.map((o) => [o, model.weights[o].slice()])) as Record<Organ, number[]>,
    samples: { ...model.samples },
    updatedAt: new Date().toISOString(),
  };
  for (const s of samples) {
    const w = next.weights[s.organ];
    const p = sigmoid(s.features.reduce((acc, xi, i) => acc + xi * w[i], 0));
    const g = (s.weight ?? 1) * (s.label - p);
    for (let i = 0; i < w.length; i++) w[i] += lr * (g * s.features[i] - lambda * (w[i] - AE_PRIOR_WEIGHTS[i]));
    next.samples[s.organ] += 1;
  }
  return next;
}

/** Build training samples from an observed outcome: reported organs are positives, others negatives. */
export function samplesFromOutcome(sim: SimulationResult, patient: Patient, drugId: string, observed: { organ: Organ; occurred: boolean }[]): AETrainingSample[] {
  const d = getDrug(drugId);
  const s = sim.series[drugId];
  if (!s) return [];
  const basis: ExposureBasis = d.toxic?.basis ?? 'peak';
  const toxValue = d.toxic ? d.toxic.value : referenceConcentration(d) * d.display.factor * 4;
  const exposure = exposureSeries(sim, s.active ?? s.conc, basis, sim.metrics[drugId]?.intervalH ?? 24);
  const peakRatio = Math.max(...exposure, 1e-6) / toxValue;
  const drugs = sim.drugIds.map(getDrug);
  const organs = new Set<Organ>([...d.organs.filter((o) => o.kind === 'adverse').map((o) => o.organ), ...observed.map((o) => o.organ)]);
  return Array.from(organs).map((organ) => {
    const obs = observed.find((o) => o.organ === organ);
    return {
      organ,
      features: aeFeatures(d, organ, peakRatio, patient, sim.physiology, drugs),
      label: obs?.occurred ? 1 : 0,
      // An organ not mentioned is weak evidence of absence.
      weight: obs ? 1 : 0.3,
    };
  });
}
