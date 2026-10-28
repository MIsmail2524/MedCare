import type { Pathway, Patient, Phenotype, Physiology } from './types.js';

/** Activity of each pathway relative to a normal metaboliser. */
export const PHENOTYPE_ACTIVITY: Record<'CYP2D6' | 'CYP2C19' | 'CYP2C9' | 'CYP3A5', Record<Phenotype, number>> = {
  CYP2D6: { PM: 0.05, IM: 0.4, NM: 1, RM: 1.5, UM: 2.5 },
  CYP2C19: { PM: 0.1, IM: 0.6, NM: 1, RM: 1.4, UM: 1.8 },
  CYP2C9: { PM: 0.25, IM: 0.6, NM: 1, RM: 1, UM: 1 },
  // CYP3A5 is additive: reference population (*3/*3 non-expressers) has zero activity.
  CYP3A5: { PM: 0, IM: 0.8, NM: 1.6, RM: 1.6, UM: 1.6 },
};

export const PHENOTYPE_LABEL: Record<Phenotype, string> = {
  PM: 'Poor metaboliser',
  IM: 'Intermediate metaboliser',
  NM: 'Normal metaboliser',
  RM: 'Rapid metaboliser',
  UM: 'Ultrarapid metaboliser',
};

export const VKORC1_EC50_FACTOR = { GG: 1, AG: 0.7, AA: 0.45 } as const;

export interface ProcedureDef {
  id: string;
  name: string;
  category: 'Bariatric / GI' | 'Hepatobiliary' | 'Renal / Urology' | 'Cardiothoracic' | 'Orthopaedic' | 'General / Endocrine';
  description: string;
  /** Multipliers applied to physiology; `tau` (days) gives exponential recovery toward 1. */
  absorption?: number;
  hepatic?: number;
  volume?: number;
  tauDays?: number;
  alerts: string[];
  organs: string[];
}

export const PROCEDURES: ProcedureDef[] = [
  {
    id: 'rygb', name: 'Roux-en-Y gastric bypass', category: 'Bariatric / GI',
    description: 'Bypasses stomach and proximal small bowel; reduces absorptive surface and acid exposure.',
    absorption: 0.7, alerts: ['Avoid NSAIDs (marginal ulcer risk).', 'Extended-release products may be poorly absorbed — prefer immediate release.', 'Monitor levels of narrow-therapeutic-index oral drugs.'],
    organs: ['gi'],
  },
  {
    id: 'sleeve', name: 'Sleeve gastrectomy', category: 'Bariatric / GI',
    description: 'Resection of ~80% of the stomach; faster gastric emptying.',
    absorption: 0.85, alerts: ['Altered absorption of drugs requiring acid (e.g. azoles, iron).'], organs: ['gi'],
  },
  {
    id: 'total_gastrectomy', name: 'Total gastrectomy', category: 'Bariatric / GI',
    description: 'Removal of the stomach with oesophago-jejunal anastomosis.',
    absorption: 0.75, alerts: ['Lifelong vitamin B12 replacement required.', 'Rapid transit: dumping syndrome.'], organs: ['gi'],
  },
  {
    id: 'sbr', name: 'Small-bowel resection (> 100 cm)', category: 'Bariatric / GI',
    description: 'Short-bowel physiology with reduced absorption.',
    absorption: 0.6, alerts: ['Consider parenteral routes for critical drugs.', 'Monitor levels for oral narrow-index drugs.'], organs: ['gi'],
  },
  {
    id: 'hepatectomy', name: 'Partial hepatectomy', category: 'Hepatobiliary',
    description: 'Resection of liver parenchyma; regeneration over weeks to months.',
    hepatic: 0.55, tauDays: 30, alerts: ['Reduce doses of high-hepatic-clearance drugs early post-op.', 'Avoid hepatotoxins (acetaminophen ≤ 2 g/day).'], organs: ['liver'],
  },
  {
    id: 'liver_tx', name: 'Liver transplant', category: 'Hepatobiliary',
    description: 'Orthotopic liver transplant with lifelong immunosuppression.',
    hepatic: 0.8, tauDays: 60, alerts: ['Calcineurin-inhibitor interactions (CYP3A4).', 'Infection prophylaxis required.'], organs: ['liver', 'blood'],
  },
  {
    id: 'cholecystectomy', name: 'Cholecystectomy', category: 'Hepatobiliary',
    description: 'Gallbladder removal. Minimal pharmacokinetic consequence.',
    alerts: [], organs: ['gi'],
  },
  {
    id: 'nephrectomy', name: 'Unilateral nephrectomy', category: 'Renal / Urology',
    description: 'Removal of one kidney. Compensatory hypertrophy restores ~70–75% of baseline GFR.',
    alerts: ['Ensure serum creatinine reflects post-operative function.', 'Avoid nephrotoxins: single kidney has reduced reserve.'], organs: ['kidneys'],
  },
  {
    id: 'kidney_tx', name: 'Kidney transplant', category: 'Renal / Urology',
    description: 'Renal allograft with lifelong immunosuppression.',
    alerts: ['Tacrolimus interactions (CYP3A4/P-gp).', 'Avoid NSAIDs.', 'Dose by allograft eGFR.'], organs: ['kidneys', 'blood'],
  },
  {
    id: 'cabg', name: 'CABG with cardiopulmonary bypass', category: 'Cardiothoracic',
    description: 'Haemodilution, hypothermia and inflammation alter distribution and hepatic clearance transiently.',
    volume: 1.25, hepatic: 0.8, tauDays: 3, alerts: ['Post-op AF common — amiodarone interactions.', 'Bleeding risk with antithrombotics early post-op.'], organs: ['heart', 'blood'],
  },
  {
    id: 'pci', name: 'PCI with drug-eluting stent', category: 'Cardiothoracic',
    description: 'Requires dual antiplatelet therapy.',
    alerts: ['DAPT required: check CYP2C19 before clopidogrel.', 'Avoid omeprazole/esomeprazole with clopidogrel.'], organs: ['heart', 'blood'],
  },
  {
    id: 'valve', name: 'Mechanical heart-valve replacement', category: 'Cardiothoracic',
    description: 'Lifelong warfarin anticoagulation.',
    alerts: ['Warfarin INR target 2.5–3.5 (mitral) — DOACs contraindicated.'], organs: ['heart', 'blood'],
  },
  {
    id: 'arthroplasty', name: 'Hip/knee arthroplasty', category: 'Orthopaedic',
    description: 'Major orthopaedic surgery with high VTE risk.',
    alerts: ['VTE prophylaxis (e.g. enoxaparin) for 10–35 days.', 'Neuraxial anaesthesia timing with LMWH.'], organs: ['muscle', 'blood'],
  },
  {
    id: 'splenectomy', name: 'Splenectomy', category: 'General / Endocrine',
    description: 'Asplenia: impaired encapsulated-organism immunity.',
    alerts: ['Pneumococcal, meningococcal, Hib vaccination.', 'Standby antibiotics for fever.'], organs: ['blood'],
  },
  {
    id: 'thyroidectomy', name: 'Total thyroidectomy', category: 'General / Endocrine',
    description: 'Requires lifelong levothyroxine; risk of hypoparathyroidism.',
    alerts: ['Monitor calcium post-op.', 'Amiodarone and lithium thyroid effects no longer relevant; levothyroxine absorption interactions.'], organs: ['thyroid'],
  },
];

export const PROCEDURE_MAP: Record<string, ProcedureDef> = Object.assign(Object.create(null), Object.fromEntries(PROCEDURES.map((p) => [p.id, p])));

const CHILD_PUGH_FACTOR = { none: 1, A: 0.8, B: 0.55, C: 0.35 } as const;

/**
 * Developmental (ontogeny) fraction of adult enzyme activity by postnatal age, as sigmoid
 * maturation curves f = f₀ + (1 − f₀)·Aʰ/(A50ʰ + Aʰ) (A in years), approximating published
 * paediatric PBPK ontogeny profiles (Salem 2014; Upreti & Wahlstrom 2016).
 */
export const ONTOGENY: Record<string, { f0: number; a50: number; h: number }> = {
  CYP3A4: { f0: 0.11, a50: 0.3, h: 1.0 },
  CYP2D6: { f0: 0.1, a50: 0.12, h: 1.2 },
  CYP2C9: { f0: 0.2, a50: 0.35, h: 1.1 },
  CYP2C19: { f0: 0.3, a50: 0.3, h: 1.0 },
  CYP1A2: { f0: 0.05, a50: 0.6, h: 1.6 },
  CYP2B6: { f0: 0.2, a50: 0.5, h: 1.0 },
  CYP2E1: { f0: 0.1, a50: 0.4, h: 1.2 },
  UGT: { f0: 0.1, a50: 0.8, h: 1.6 },
  Pgp: { f0: 0.3, a50: 0.5, h: 1.0 },
};
export function ontogenyFactors(ageYears: number): Record<string, number> {
  const a = Math.max(ageYears, 0.001);
  return Object.fromEntries(Object.entries(ONTOGENY).map(([k, o]) => [k, o.f0 + ((1 - o.f0) * a ** o.h) / (o.a50 ** o.h + a ** o.h)]));
}

export function idealBodyWeight(sex: Patient['sex'], heightCm: number): number {
  const base = sex === 'male' ? 50 : 45.5;
  return Math.max(base + 0.9055 * (heightCm - 152.4), 0.5 * base);
}

export function leanBodyWeight(sex: Patient['sex'], weightKg: number, heightCm: number): number {
  const bmi = weightKg / (heightCm / 100) ** 2;
  return sex === 'male' ? (9270 * weightKg) / (6680 + 216 * bmi) : (9270 * weightKg) / (8780 + 244 * bmi);
}

export function bodySurfaceArea(weightKg: number, heightCm: number): number {
  return Math.sqrt((weightKg * heightCm) / 3600);
}

/** CKD-EPI 2021 race-free equation, mL/min/1.73 m². */
export function ckdEpi2021(scr: number, age: number, sex: Patient['sex']): number {
  const k = sex === 'female' ? 0.7 : 0.9;
  const a = sex === 'female' ? -0.241 : -0.302;
  const r = scr / k;
  return 142 * Math.min(r, 1) ** a * Math.max(r, 1) ** -1.2 * 0.9938 ** age * (sex === 'female' ? 1.012 : 1);
}

export function cockcroftGault(age: number, weightKg: number, scr: number, sex: Patient['sex']): number {
  return (((140 - age) * weightKg) / (72 * Math.max(scr, 0.2))) * (sex === 'female' ? 0.85 : 1);
}

export function ckdStage(egfr: number): string {
  if (egfr >= 90) return 'G1';
  if (egfr >= 60) return 'G2';
  if (egfr >= 45) return 'G3a';
  if (egfr >= 30) return 'G3b';
  if (egfr >= 15) return 'G4';
  return 'G5';
}

function procedureFactor(base: number | undefined, tauDays: number | undefined, daysSince: number): number {
  if (base === undefined || daysSince < 0) return 1;
  if (!tauDays) return base;
  return 1 - (1 - base) * Math.exp(-daysSince / tauDays);
}

/** Derive physiological covariates of the digital twin at a given date. */
export function derivePhysiology(p: Patient, at: Date = new Date()): Physiology {
  const notes: string[] = [];
  const bmi = p.weightKg / (p.heightCm / 100) ** 2;
  const bsa = bodySurfaceArea(p.weightKg, p.heightCm);
  const ibw = idealBodyWeight(p.sex, p.heightCm);
  const abw = ibw + 0.4 * Math.max(p.weightKg - ibw, 0);
  const lbw = leanBodyWeight(p.sex, p.weightKg, p.heightCm);

  let crcl: number;
  let crclWeight: Physiology['crclWeight'] = 'IBW';
  let egfr: number;
  if (p.age < 18) {
    // Bedside Schwartz (2009), converted from per-1.73 m² to absolute.
    egfr = (0.413 * p.heightCm) / Math.max(p.scr, 0.1);
    crcl = (egfr * bsa) / 1.73;
    crclWeight = 'TBW';
    notes.push('Paediatric: renal function estimated with bedside Schwartz equation.');
  } else {
    let w = ibw;
    if (p.weightKg < ibw) {
      w = p.weightKg;
      crclWeight = 'TBW';
    } else if (p.weightKg > 1.2 * ibw) {
      w = abw;
      crclWeight = 'ABW';
    }
    crcl = cockcroftGault(p.age, w, p.scr, p.sex);
    egfr = ckdEpi2021(p.scr, p.age, p.sex);
  }

  let hepaticFactor = CHILD_PUGH_FACTOR[p.childPugh];
  if (p.age > 40) hepaticFactor *= Math.max(0.75, 1 - 0.005 * (p.age - 40));
  if (p.heartFailure) {
    hepaticFactor *= 0.8;
    notes.push('Heart failure: reduced hepatic blood flow lowers clearance of high-extraction drugs.');
  }
  let absorptionFactor = 1;
  let volumeFactor = 1;

  const enzymeActivity: Record<Pathway, number> = {
    CYP3A4: 1,
    CYP3A5: PHENOTYPE_ACTIVITY.CYP3A5[p.phenotypes.CYP3A5],
    CYP2D6: PHENOTYPE_ACTIVITY.CYP2D6[p.phenotypes.CYP2D6],
    CYP2C9: PHENOTYPE_ACTIVITY.CYP2C9[p.phenotypes.CYP2C9],
    CYP2C19: PHENOTYPE_ACTIVITY.CYP2C19[p.phenotypes.CYP2C19],
    CYP1A2: 1,
    CYP2B6: 1,
    CYP2E1: 1,
    UGT: 1,
    Pgp: 1,
  };
  if (p.age < 18) {
    for (const [pw, f] of Object.entries(ontogenyFactors(p.age)) as [Pathway, number][]) enzymeActivity[pw] *= f;
    if (p.age < 2) notes.push(`Infant enzyme ontogeny: CYP3A4 ${(ontogenyFactors(p.age).CYP3A4 * 100).toFixed(0)}%, UGT ${(ontogenyFactors(p.age).UGT * 100).toFixed(0)}% of adult activity.`);
  }
  if (p.smoker) {
    enzymeActivity.CYP1A2 *= 1.7;
    notes.push('Smoking induces CYP1A2 (~1.7×): theophylline, clozapine, olanzapine clearance ↑.');
  }
  if (p.alcoholUse === 'heavy') {
    enzymeActivity.CYP2E1 *= 2;
    notes.push('Heavy alcohol use induces CYP2E1 and depletes glutathione — acetaminophen hepatotoxicity risk ↑.');
  }
  if (p.pregnant) {
    enzymeActivity.CYP3A4 *= 1.35;
    enzymeActivity.CYP2D6 *= 1.5;
    enzymeActivity.CYP1A2 *= 0.6;
    enzymeActivity.UGT *= 1.5;
    volumeFactor *= 1.2;
    notes.push('Pregnancy: plasma volume ↑, CYP3A4/2D6/UGT ↑, CYP1A2 ↓ (third-trimester values).');
  }
  if (p.albumin < 3.5) notes.push(`Hypoalbuminaemia (${p.albumin} g/dL): free fraction of highly bound drugs ↑.`);

  for (const rec of p.procedures) {
    const def = PROCEDURE_MAP[rec.type];
    if (!def) continue;
    const days = (at.getTime() - new Date(rec.date).getTime()) / 86400000;
    if (days < 0) continue;
    const a = procedureFactor(def.absorption, def.tauDays, days);
    const h = procedureFactor(def.hepatic, def.tauDays, days);
    const v = procedureFactor(def.volume, def.tauDays, days);
    absorptionFactor *= a;
    hepaticFactor *= h;
    volumeFactor *= v;
    if (a < 0.99 || h < 0.99 || v > 1.01) {
      const parts: string[] = [];
      if (a < 0.99) parts.push(`oral absorption ×${a.toFixed(2)}`);
      if (h < 0.99) parts.push(`hepatic clearance ×${h.toFixed(2)}`);
      if (v > 1.01) parts.push(`distribution volume ×${v.toFixed(2)}`);
      notes.push(`${def.name} (${Math.round(days)} d ago): ${parts.join(', ')}.`);
    }
  }

  const renalFactor = Math.min(Math.max(crcl / 100, 0.03), 2);
  if (crcl < 30) notes.push(`Severe renal impairment (CrCl ${crcl.toFixed(0)} mL/min): renally cleared drugs accumulate.`);
  else if (crcl < 60) notes.push(`Moderate renal impairment (CrCl ${crcl.toFixed(0)} mL/min).`);
  if (crcl > 130) notes.push('Augmented renal clearance: renally cleared antibiotics may be sub-therapeutic.');

  return {
    bmi,
    bsa,
    ibw,
    abw,
    lbw,
    crcl,
    crclWeight,
    egfr,
    ckdStage: ckdStage(egfr),
    hepaticFactor,
    absorptionFactor,
    volumeFactor,
    renalFactor,
    baselineQTc: p.baselineQTc ?? (p.sex === 'female' ? 420 : 410),
    baselineHR: p.baselineHR ?? 72,
    baselineSBP: p.baselineSBP ?? 130,
    enzymeActivity,
    notes,
  };
}

export function defaultPatient(overrides: Partial<Patient> = {}): Patient {
  return {
    name: 'Reference adult',
    age: 40,
    sex: 'male',
    weightKg: 70,
    heightCm: 175,
    scr: 0.9,
    albumin: 4.2,
    potassium: 4.2,
    childPugh: 'none',
    phenotypes: { CYP2D6: 'NM', CYP2C19: 'NM', CYP2C9: 'NM', CYP3A5: 'PM' },
    vkorc1: 'GG',
    hla: { B1502: false, B5701: false, B5801: false },
    smoker: false,
    alcoholUse: 'none',
    pregnant: false,
    heartFailure: false,
    conditions: [],
    allergies: [],
    procedures: [],
    medicationHistory: [],
    labs: [],
    ...overrides,
  };
}
