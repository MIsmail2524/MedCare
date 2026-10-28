import { getDrug } from './drugs.js';
import { defaultPatient, ontogenyFactors } from './physiology.js';
import { makeRegimen, simulate } from './pk.js';
import type { Patient } from './types.js';

// Paediatric twin: growth (WHO-median weight/height), renal maturation and enzyme ontogeny feed the
// same mechanistic simulator, so "how much drug does this child need for adult-equivalent exposure"
// is answered by simulation instead of mg/kg scaling.

/** Approximate WHO/CDC 50th-centile weight (kg) and height (cm) by age (years). */
export function growthMedian(age: number, sex: 'male' | 'female'): { weightKg: number; heightCm: number } {
  const pts: [number, number, number][] = [
    [0, 3.4, 50], [0.25, 6.0, 61], [0.5, 7.8, 67], [1, 9.8, 75], [2, 12.3, 87], [4, 16.3, 103], [6, 20.5, 116], [8, 25.6, 128], [10, 32, 139], [12, 40, 150], [14, 50, 162], [16, 58, 170], [18, 66, 175],
  ];
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1][0] < age) i++;
  const [a0, w0, h0] = pts[i];
  const [a1, w1, h1] = pts[i + 1];
  const f = Math.min(Math.max((age - a0) / (a1 - a0), 0), 1);
  const sexF = sex === 'female' && age > 11 ? 0.92 : sex === 'female' ? 0.97 : 1;
  return { weightKg: (w0 + f * (w1 - w0)) * sexF, heightCm: (h0 + f * (h1 - h0)) * (sex === 'female' && age > 12 ? 0.96 : 1) };
}

/** Typical serum creatinine (mg/dL) by age for a healthy child. */
export function normalScr(age: number): number {
  if (age < 0.1) return 0.6;
  if (age < 1) return 0.3;
  if (age < 4) return 0.35;
  if (age < 10) return 0.45;
  if (age < 14) return 0.6;
  return 0.75;
}

export function childPatient(age: number, sex: 'male' | 'female' = 'male', overrides: Partial<Patient> = {}): Patient {
  const g = growthMedian(age, sex);
  return defaultPatient({ name: `Child ${age} y`, age, sex, weightKg: Math.round(g.weightKg * 10) / 10, heightCm: Math.round(g.heightCm), scr: normalScr(age), ...overrides });
}

export interface PaediatricDosePoint {
  age: number;
  weightKg: number;
  mgPerKgLinear: number;
  mgPerKgTwin: number;
  aucRatioAtLinear: number;
  ontogeny: Record<string, number>;
}

/** Per age: the mg/kg dose matching adult AUC₂₄ under the twin vs naive linear mg/kg scaling. */
export function paediatricDoseCurve(drugId: string, ages = [0.1, 0.5, 1, 2, 4, 8, 12, 16]): PaediatricDosePoint[] {
  const d = getDrug(drugId);
  const reg = makeRegimen(drugId, { doses: Math.max(1, Math.round(120 / d.defaultRegimen.intervalH)) });
  const adultMg = d.defaultRegimen.unit === 'mg/kg' ? d.defaultRegimen.dose * 70 : d.defaultRegimen.dose;
  const auc = (p: Patient, mg: number) => simulate({ patient: p, regimens: [{ ...reg, dose: mg, unit: 'mg' }], metricsOnly: true }).metrics[drugId].auc24;
  const ref = auc(defaultPatient(), adultMg);
  return ages.map((age) => {
    const p = childPatient(age);
    const linear = (adultMg / 70) * p.weightKg;
    const aLin = auc(p, linear) / ref;
    let lo = linear * 0.05;
    let hi = linear * 20;
    for (let i = 0; i < 26; i++) {
      const mid = Math.sqrt(lo * hi);
      if (auc(p, mid) < ref) lo = mid;
      else hi = mid;
    }
    return { age, weightKg: p.weightKg, mgPerKgLinear: linear / p.weightKg, mgPerKgTwin: Math.sqrt(lo * hi) / p.weightKg, aucRatioAtLinear: aLin, ontogeny: ontogenyFactors(age) };
  });
}
