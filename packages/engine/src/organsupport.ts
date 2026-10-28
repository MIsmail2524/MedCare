import { getDrug, registerDrug } from './drugs.js';
import { defaultPatient } from './physiology.js';
import { makeRegimen, simulate } from './pk.js';
import type { Drug, Patient, Regimen } from './types.js';

// Organ-support & critical-care twin: the patient plus the machine (haemodialysis / CRRT) and the
// rapidly changing ICU physiology (augmented renal clearance, capillary leak), so dosing accounts
// for what the circuit removes and how sepsis reshapes distribution.

export type Modality = 'none' | 'ihd' | 'cvvhdf';

/** Extracorporeal clearance (L/h): free drug, filter permeability by MW, effluent / blood flow. */
export function extracorporealClearance(drug: Drug, modality: Modality, effluentMlKgH = 25, weightKg = 70): number {
  if (modality === 'none') return 0;
  const mwPenalty = drug.id === 'vancomycin' ? 0.7 : drug.id === 'doxorubicin' ? 0.6 : 1; // larger molecules sieve less
  if (modality === 'ihd') return drug.pk.fu * 9 * mwPenalty; // ≈ 150 mL/min dialyser, unbound fraction
  return drug.pk.fu * ((effluentMlKgH * weightKg) / 1000) * mwPenalty * 0.85;
}

function augmented(drug: Drug, extraCL: number, vMult: number, tag: string): Drug {
  const d: Drug = { ...drug, id: `cand:${drug.id}-${tag}`, name: `${drug.name} (${tag})`, pk: { ...drug.pk, CL: drug.pk.CL + extraCL, Vc: drug.pk.Vc * vMult, fe: (drug.pk.CL * drug.pk.fe) / (drug.pk.CL + extraCL) } };
  registerDrug(d);
  return d;
}

export interface SupportResult {
  label: string;
  auc24: number;
  trough: number;
  targetStatus: string;
  t: number[];
  conc: number[];
}

export interface OrganSupportComparison {
  drugId: string;
  scenarios: SupportResult[];
  recommendation: string;
}

/**
 * Compare exposure for: normal kidneys, anuric (no therapy), intermittent HD (4 h sessions,
 * 3×/week, modelled as session-averaged clearance), CVVHDF, and septic shock with ARC + capillary leak.
 */
export function organSupportScenarios(drugId: string, base: Patient = defaultPatient({ age: 60, weightKg: 80 }), regimen?: Regimen): OrganSupportComparison {
  const d = getDrug(drugId);
  const reg = regimen ?? makeRegimen(drugId, { doses: Math.max(1, Math.round(168 / d.defaultRegimen.intervalH)) });
  const anuric = { ...base, scr: 8 };
  const run = (label: string, patient: Patient, drug: Drug) => {
    const r = { ...reg, drugId: drug.id };
    const s = simulate({ patient, regimens: [r], durationH: 168 });
    const m = s.metrics[drug.id];
    return { label, auc24: m.auc24, trough: m.troughLast, targetStatus: m.targetStatus, t: s.t, conc: s.series[drug.id].conc };
  };
  const ihdCL = (extracorporealClearance(d, 'ihd') * 12) / 168; // 3 × 4 h per week, averaged
  const scenarios = [
    run('Normal renal function', base, d),
    run('Anuric, no renal replacement', anuric, d),
    run('Intermittent haemodialysis (3×4 h/week)', anuric, augmented(d, ihdCL, 1, 'ihd')),
    run('CVVHDF 25 mL/kg/h', anuric, augmented(d, extracorporealClearance(d, 'cvvhdf', 25, base.weightKg), 1, 'crrt')),
    run('Septic shock: ARC (CrCl ≈ 180) + capillary leak (V +40 %)', { ...base, scr: 0.45 }, augmented(d, 0, 1.4, 'sepsis')),
  ];
  const ref = scenarios[0].auc24;
  const recs = scenarios.slice(1).map((s) => `${s.label}: AUC ${(s.auc24 / ref).toFixed(2)}× normal → ${s.auc24 / ref > 1.3 ? `reduce dose ≈ ${Math.round((1 - ref / s.auc24) * 100)}%` : s.auc24 / ref < 0.77 ? `increase dose ≈ ${Math.round((ref / s.auc24 - 1) * 100)}% or shorten interval` : 'no change'}`);
  return { drugId, scenarios, recommendation: recs.join(' · ') };
}

/** Fraction of body load removed by one dialysis session (two-pool-free, one-compartment approximation). */
export function sessionRemoval(drugId: string, hours = 4, weightKg = 70): number {
  const d = getDrug(drugId);
  const V = (d.pk.Vc + (d.pk.Vp ?? 0)) * weightKg;
  return 1 - Math.exp((-extracorporealClearance(d, 'ihd') * hours) / V);
}
