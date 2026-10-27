// Early drug-development calculations for novel compounds:
// drug-likeness, first-in-human starting dose (FDA 2005 guidance), allometric scaling and
// single/multiple ascending dose simulation with a one-compartment model.

export type Species = 'mouse' | 'rat' | 'rabbit' | 'dog' | 'monkey' | 'minipig';

/** Body-surface-area conversion factors (Km) from FDA guidance (2005), Table 1. */
export const KM_FACTORS: Record<Species | 'human', { km: number; weightKg: number }> = {
  mouse: { km: 3, weightKg: 0.02 },
  rat: { km: 6, weightKg: 0.15 },
  rabbit: { km: 12, weightKg: 1.8 },
  dog: { km: 20, weightKg: 10 },
  monkey: { km: 12, weightKg: 3 },
  minipig: { km: 35, weightKg: 40 },
  human: { km: 37, weightKg: 60 },
};

export interface CompoundInput {
  name: string;
  mw: number;
  logP: number;
  hbd: number;
  hba: number;
  tpsa: number;
  rotatableBonds: number;
  /** Aqueous solubility mg/mL */
  solubility: number;
  /** Caco-2 / effective permeability, ×10⁻⁶ cm/s */
  permeability: number;
  fu: number;
  // preclinical
  species: Species;
  noaelMgKg: number;
  animalCL_mLminKg: number;
  animalVss_Lkg: number;
  /** Target efficacious concentration (mg/L) */
  targetConc: number;
  safetyFactor: number;
  F: number;
  ka: number;
}

export const EXAMPLE_COMPOUND: CompoundInput = {
  name: 'MC-1042 (example kinase inhibitor)',
  mw: 452.5,
  logP: 3.4,
  hbd: 2,
  hba: 7,
  tpsa: 96,
  rotatableBonds: 6,
  solubility: 0.08,
  permeability: 18,
  fu: 0.08,
  species: 'rat',
  noaelMgKg: 50,
  animalCL_mLminKg: 25,
  animalVss_Lkg: 2.1,
  targetConc: 0.25,
  safetyFactor: 10,
  F: 0.45,
  ka: 0.9,
};

export interface DruglikenessResult {
  lipinskiViolations: string[];
  veberViolations: string[];
  bcsClass: 'I' | 'II' | 'III' | 'IV';
  oralAbsorptionOutlook: 'good' | 'moderate' | 'poor';
  notes: string[];
}

export function assessDruglikeness(c: CompoundInput, humanDoseMg = 100): DruglikenessResult {
  const lip: string[] = [];
  if (c.mw > 500) lip.push(`MW ${c.mw} > 500`);
  if (c.logP > 5) lip.push(`logP ${c.logP} > 5`);
  if (c.hbd > 5) lip.push(`H-bond donors ${c.hbd} > 5`);
  if (c.hba > 10) lip.push(`H-bond acceptors ${c.hba} > 10`);
  const veb: string[] = [];
  if (c.tpsa > 140) veb.push(`TPSA ${c.tpsa} Å² > 140`);
  if (c.rotatableBonds > 10) veb.push(`Rotatable bonds ${c.rotatableBonds} > 10`);
  // BCS: high solubility if highest dose dissolves in 250 mL; high permeability ≥ metoprolol (~20e-6 cm/s Caco-2 proxy)
  const highSol = humanDoseMg / c.solubility <= 250;
  const highPerm = c.permeability >= 15;
  const bcsClass = highSol && highPerm ? 'I' : !highSol && highPerm ? 'II' : highSol && !highPerm ? 'III' : 'IV';
  const issues = lip.length + veb.length + (bcsClass === 'IV' ? 2 : bcsClass === 'I' ? 0 : 1);
  const notes: string[] = [];
  if (bcsClass === 'II') notes.push('Solubility-limited absorption: consider salt form, amorphous dispersion or particle-size reduction.');
  if (bcsClass === 'III') notes.push('Permeability-limited absorption: consider prodrug or permeation enhancers.');
  if (bcsClass === 'IV') notes.push('Low solubility and permeability: oral development challenging.');
  if (c.fu < 0.01) notes.push('Very high protein binding: free concentration sensitive to albumin and displacement.');
  if (c.logP > 4) notes.push('High lipophilicity: risk of hERG binding, CYP metabolism and promiscuity.');
  return {
    lipinskiViolations: lip,
    veberViolations: veb,
    bcsClass,
    oralAbsorptionOutlook: issues === 0 ? 'good' : issues <= 2 ? 'moderate' : 'poor',
    notes,
  };
}

export interface FihResult {
  hedMgKg: number;
  mrsdMgKg: number;
  mrsdMg: number;
  humanCL_Lh: number;
  humanVss_L: number;
  halfLifeH: number;
  /** Dose (mg) for average steady-state concentration = target with q24h dosing */
  efficaciousDoseMg: number;
  marginToEfficacious: number;
  method: string[];
}

/** Human equivalent dose and maximum recommended starting dose (FDA 2005) plus allometric PK. */
export function firstInHuman(c: CompoundInput, humanWeightKg = 70): FihResult {
  const animal = KM_FACTORS[c.species];
  const hed = c.noaelMgKg * (animal.km / KM_FACTORS.human.km);
  const mrsd = hed / c.safetyFactor;
  // Simple allometry: CL ∝ W^0.75, Vss ∝ W^1.0
  const animalCL_Lh = (c.animalCL_mLminKg * animal.weightKg * 60) / 1000;
  const humanCL = animalCL_Lh * (humanWeightKg / animal.weightKg) ** 0.75;
  const humanV = c.animalVss_Lkg * humanWeightKg;
  const t12 = (0.693 * humanV) / humanCL;
  const eff = (c.targetConc * humanCL * 24) / Math.max(c.F, 0.01);
  return {
    hedMgKg: hed,
    mrsdMgKg: mrsd,
    mrsdMg: mrsd * humanWeightKg,
    humanCL_Lh: humanCL,
    humanVss_L: humanV,
    halfLifeH: t12,
    efficaciousDoseMg: eff,
    marginToEfficacious: eff / (mrsd * humanWeightKg),
    method: [
      `HED = NOAEL × (Km ${c.species} ${animal.km} / Km human 37) = ${hed.toFixed(2)} mg/kg`,
      `MRSD = HED / safety factor ${c.safetyFactor} = ${mrsd.toFixed(3)} mg/kg (${(mrsd * humanWeightKg).toFixed(1)} mg for ${humanWeightKg} kg)`,
      `Human CL = CL_animal × (70 / ${animal.weightKg})^0.75 = ${humanCL.toFixed(2)} L/h (simple allometry)`,
      `Human Vss = ${c.animalVss_Lkg} L/kg × ${humanWeightKg} kg = ${humanV.toFixed(0)} L`,
      `Predicted t½ = 0.693 × Vss / CL = ${t12.toFixed(1)} h`,
    ],
  };
}

export interface AscendingCohort {
  doseMg: number;
  t: number[];
  conc: number[];
  cmax: number;
  auc: number;
  accumulation: number;
  aboveTarget: boolean;
}

/** One-compartment oral profile (Bateman) for SAD (single dose) or MAD (q24h × 7) cohorts. */
export function ascendingDoseStudy(c: CompoundInput, fih: FihResult, doses: number[], multiple: boolean): AscendingCohort[] {
  const k = fih.humanCL_Lh / fih.humanVss_L;
  const ka = Math.max(c.ka, k * 1.01);
  const V = fih.humanVss_L;
  const tau = 24;
  const nDoses = multiple ? 7 : 1;
  const tEnd = multiple ? tau * nDoses : Math.max(24, Math.min(240, 5 * (0.693 / k)));
  const pts = 241;
  return doses.map((dose) => {
    const t: number[] = [];
    const conc: number[] = [];
    let cmax = 0;
    let auc = 0;
    for (let i = 0; i < pts; i++) {
      const ti = (tEnd * i) / (pts - 1);
      let ci = 0;
      for (let d = 0; d < nDoses; d++) {
        const td = ti - d * tau;
        if (td < 0) break;
        ci += ((c.F * dose * ka) / (V * (ka - k))) * (Math.exp(-k * td) - Math.exp(-ka * td));
      }
      t.push(ti);
      conc.push(ci);
      if (ci > cmax) cmax = ci;
      if (i > 0) auc += 0.5 * (ci + conc[i - 1]) * (ti - t[i - 1]);
    }
    const accumulation = multiple ? 1 / (1 - Math.exp(-k * tau)) : 1;
    return { doseMg: dose, t, conc, cmax, auc, accumulation, aboveTarget: cmax >= c.targetConc };
  });
}

/** Modified-Fibonacci escalation from a starting dose. */
export function escalationDoses(start: number, cohorts = 6): number[] {
  const steps = [1, 2, 1.67, 1.5, 1.4, 1.33, 1.33, 1.33];
  const out: number[] = [];
  let d = start;
  for (let i = 0; i < cohorts; i++) {
    d = i === 0 ? start : d * steps[Math.min(i, steps.length - 1)];
    out.push(Number(d.toPrecision(3)));
  }
  return out;
}
