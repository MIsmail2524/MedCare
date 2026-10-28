import { getDrug, registerDrug } from './drugs.js';
import { defaultPatient, derivePhysiology } from './physiology.js';
import { makeRegimen, simulate } from './pk.js';
import { rng } from './population.js';
import { jaccard, type KBDrug, type SafetyKB } from './safety.js';
import type { Drug, Patient, Physiology, Regimen } from './types.js';

// ---------------------------------------------------------------------------
// Veterinary twin: allometric species scaling with species-specific metabolic gaps (e.g. feline
// glucuronidation deficiency), and food-animal withdrawal times to a tissue tolerance.

export interface AnimalSpecies {
  id: string;
  name: string;
  weightKg: number;
  clExponent: number;
  /** relative pathway activity vs human */
  pathways: Partial<Record<'UGT' | 'CYP3A4' | 'CYP2D6' | 'CYP2C9' | 'CYP1A2', number>>;
  foodAnimal: boolean;
  note: string;
}

export const SPECIES: AnimalSpecies[] = [
  { id: 'dog', name: 'Dog', weightKg: 20, clExponent: 0.75, pathways: { CYP2D6: 1.2, CYP3A4: 1.1 }, foodAnimal: false, note: 'MDR1 (ABCB1) mutation in herding breeds increases CNS drug penetration.' },
  { id: 'cat', name: 'Cat', weightKg: 4, clExponent: 0.75, pathways: { UGT: 0.08 }, foodAnimal: false, note: 'UGT1A6 pseudogene: very low glucuronidation — acetaminophen, NSAIDs and some opioids accumulate.' },
  { id: 'cattle', name: 'Cattle', weightKg: 500, clExponent: 0.7, pathways: { CYP3A4: 1.2 }, foodAnimal: true, note: 'Ruminal absorption delays oral drugs; withdrawal times required for meat and milk.' },
  { id: 'horse', name: 'Horse', weightKg: 450, clExponent: 0.72, pathways: { CYP3A4: 1.3 }, foodAnimal: true, note: 'Hindgut fermenter — antibiotic-associated colitis risk.' },
];

export interface SpeciesResult {
  species: AnimalSpecies;
  cl: number;
  halfLifeH: number;
  doseMgKgForHumanAuc: number;
  aucRatioAtHumanMgKg: number;
  withdrawalDays: number | null;
}

export function speciesTwin(drugId: string, sp: AnimalSpecies, toleranceMgL = 0.01): SpeciesResult {
  const d = getDrug(drugId);
  const pathFactor = d.metabolism.reduce((s, m) => s + m.fm * ((sp.pathways as Record<string, number>)[m.pathway] ?? 1), 0) + Math.max(0, 1 - d.metabolism.reduce((s, m) => s + m.fm, 0));
  const humanCL = d.pk.CL;
  const cl = humanCL * (sp.weightKg / 70) ** sp.clExponent * (d.pk.fe + (1 - d.pk.fe) * pathFactor);
  const v = (d.pk.Vc + (d.pk.Vp ?? 0)) * sp.weightKg;
  const t12 = (0.693 * v) / Math.max(cl, 1e-9);
  const humanMgKg = (d.defaultRegimen.unit === 'mg/kg' ? d.defaultRegimen.dose : d.defaultRegimen.dose / 70);
  const humanAucPerMgKg = (70 * (d.pk.F || 1)) / humanCL;
  const spAucPerMgKg = (sp.weightKg * (d.pk.F || 1)) / cl;
  const ratio = spAucPerMgKg / humanAucPerMgKg;
  let withdrawal: number | null = null;
  if (sp.foodAnimal) {
    // Time for the 95th-percentile animal (t½ × 1.65 CV-adjusted) to fall below tolerance after the last dose (×10 tissue:plasma margin).
    const c0 = (humanMgKg * sp.weightKg) / v;
    const t95 = t12 * Math.exp(1.645 * 0.3);
    withdrawal = c0 > toleranceMgL ? Math.ceil(((Math.log(c0 / toleranceMgL) / 0.693) * t95 * 1.0) / 24) + 1 : 0;
  }
  return { species: sp, cl, halfLifeH: t12, doseMgKgForHumanAuc: humanMgKg / ratio, aucRatioAtHumanMgKg: ratio, withdrawalDays: withdrawal };
}

// ---------------------------------------------------------------------------
// Environmental exposure twin: reverse dosimetry from biomonitoring to daily intake.

export interface Chemical {
  id: string;
  name: string;
  halfLifeDays: number;
  vdLkg: number;
  matrix: string;
  unit: string; // ng/mL
  referenceDose: { value: number; unit: 'ng/kg/day'; source: string };
  typicalLevel: number;
  source: string;
}

export const CHEMICALS: Chemical[] = [
  { id: 'pfoa', name: 'PFOA (perfluorooctanoic acid)', halfLifeDays: 3.8 * 365, vdLkg: 0.17, matrix: 'serum', unit: 'ng/mL', typicalLevel: 1.4, referenceDose: { value: 0.03, unit: 'ng/kg/day', source: 'US EPA 2024 RfD (3×10⁻⁸ mg/kg/day)' }, source: 'Olsen 2007 (t½); NHANES 2017–18 median ~1.4 ng/mL' },
  { id: 'pfos', name: 'PFOS (perfluorooctane sulfonate)', halfLifeDays: 5.4 * 365, vdLkg: 0.23, matrix: 'serum', unit: 'ng/mL', typicalLevel: 4.3, referenceDose: { value: 0.1, unit: 'ng/kg/day', source: 'US EPA 2024 RfD (1×10⁻⁷ mg/kg/day)' }, source: 'Olsen 2007; NHANES median ~4 ng/mL' },
  { id: 'lead', name: 'Lead (blood)', halfLifeDays: 30, vdLkg: 0.07, matrix: 'whole blood', unit: 'µg/dL ×10 = ng/mL', typicalLevel: 8, referenceDose: { value: 500, unit: 'ng/kg/day', source: 'Illustrative (former EFSA BMDL ~0.5 µg/kg/day, nephrotoxicity)' }, source: 'Rabinowitz 1976 (blood t½); NHANES geometric mean ~0.8 µg/dL' },
  { id: 'mehg', name: 'Methylmercury (blood)', halfLifeDays: 50, vdLkg: 0.1, matrix: 'whole blood', unit: 'ng/mL', typicalLevel: 0.7, referenceDose: { value: 100, unit: 'ng/kg/day', source: 'US EPA RfD 1×10⁻⁴ mg/kg/day' }, source: 'Smith 1994 (t½ ~50 d); NHANES' },
];

export interface ReverseDosimetry {
  chemical: Chemical;
  intakeMedian: number;
  intakeP95: number;
  hazardQuotient: number;
  yearsToSteadyState: number;
}

export function reverseDosimetry(c: Chemical, level: number, n = 5000, seed = 9): ReverseDosimetry {
  const r = rng(seed);
  const intakes: number[] = [];
  for (let i = 0; i < n; i++) {
    const t12 = c.halfLifeDays * Math.exp(0.4 * r.normal());
    const vd = c.vdLkg * Math.exp(0.25 * r.normal());
    const k = 0.693 / t12; // per day
    intakes.push(level * vd * 1000 * k); // ng/mL × L/kg × 1000 mL/L × 1/day → ng/kg/day
  }
  intakes.sort((a, b) => a - b);
  const med = intakes[Math.floor(n / 2)];
  return { chemical: c, intakeMedian: med, intakeP95: intakes[Math.floor(n * 0.95)], hazardQuotient: med / c.referenceDose.value, yearsToSteadyState: (5 * c.halfLifeDays) / 365 };
}

// ---------------------------------------------------------------------------
// Extreme-environment twin: physiological modifiers applied to the patient's physiology.

export interface Environment {
  id: string;
  name: string;
  renal: number;
  hepatic: number;
  volume: number;
  absorption: number;
  note: string;
}

export const ENVIRONMENTS: Environment[] = [
  { id: 'earth', name: 'Sea level, temperate', renal: 1, hepatic: 1, volume: 1, absorption: 1, note: 'Reference' },
  { id: 'microgravity', name: 'Spaceflight (microgravity, > 2 weeks)', renal: 0.9, hepatic: 0.85, volume: 0.88, absorption: 0.85, note: 'Plasma volume −10–15 %, cephalad fluid shift, altered GI motility and hepatic flow (NASA HRP evidence).' },
  { id: 'altitude', name: 'High altitude (> 4,000 m, hypoxia)', renal: 0.85, hepatic: 0.8, volume: 0.95, absorption: 1, note: 'Hypoxia down-regulates CYP activity; reduced renal plasma flow; haemoconcentration.' },
  { id: 'heat', name: 'Extreme heat / dehydration', renal: 0.7, hepatic: 0.9, volume: 0.85, absorption: 1, note: 'Renal hypoperfusion; narrow-index renally cleared drugs (lithium, aminoglycosides) accumulate.' },
  { id: 'cold', name: 'Hypothermia (core 32–34 °C)', renal: 0.8, hepatic: 0.6, volume: 1, absorption: 0.9, note: 'Enzyme kinetics slow ~7–10 %/°C; therapeutic hypothermia prolongs sedative and opioid action.' },
];

export function environmentPhysiology(p: Patient, env: Environment): Physiology {
  const phys = derivePhysiology(p);
  const enzyme = Object.fromEntries(Object.entries(phys.enzymeActivity).map(([k, v]) => [k, v * (k === 'CYP3A5' ? 1 : env.hepatic)])) as Physiology['enzymeActivity'];
  return { ...phys, renalFactor: phys.renalFactor * env.renal, crcl: phys.crcl * env.renal, volumeFactor: phys.volumeFactor * env.volume, absorptionFactor: phys.absorptionFactor * env.absorption, enzymeActivity: enzyme, notes: [...phys.notes, `${env.name}: ${env.note}`] };
}

export function environmentComparison(drugId: string, p: Patient = defaultPatient(), regimen?: Regimen) {
  const d = getDrug(drugId);
  const reg = regimen ?? makeRegimen(drugId, { doses: Math.max(1, Math.round(120 / d.defaultRegimen.intervalH)) });
  const ref = simulate({ patient: p, physiology: environmentPhysiology(p, ENVIRONMENTS[0]), regimens: [reg], metricsOnly: true }).metrics[drugId];
  return ENVIRONMENTS.map((env) => {
    const m = simulate({ patient: p, physiology: environmentPhysiology(p, env), regimens: [reg], metricsOnly: true }).metrics[drugId];
    return { env, aucRatio: m.auc24 / ref.auc24, cmaxRatio: m.cmax / ref.cmax, status: m.toxicStatus === 'toxic' ? 'toxic' : m.targetStatus };
  });
}

// ---------------------------------------------------------------------------
// Anti-doping twin: detection windows and plausibility of a claimed exposure scenario.

export interface DetectionResult {
  t: number[];
  conc: number[];
  lastDetectableH: number | null;
  unit: string;
}

export function detectionWindow(drugId: string, dose: number, lodNgMl: number, p: Patient = defaultPatient(), horizonH = 240): DetectionResult {
  const d = getDrug(drugId);
  const reg = makeRegimen(drugId, { dose, unit: 'mg', doses: 1 });
  const s = simulate({ patient: p, regimens: [reg], durationH: horizonH });
  const ng = s.series[drugId].conc.map((c) => (c / d.display.factor) * 1000);
  let last: number | null = null;
  ng.forEach((c, i) => {
    if (c >= lodNgMl) last = s.t[i];
  });
  return { t: s.t, conc: ng, lastDetectableH: last, unit: 'ng/mL' };
}

/** Dose (mg) needed to produce the measured concentration at the claimed time after a single intake. */
export function impliedDose(drugId: string, measuredNgMl: number, hoursAfter: number, p: Patient = defaultPatient()): number {
  const d = getDrug(drugId);
  const at = (mg: number) => {
    const s = simulate({ patient: p, regimens: [makeRegimen(drugId, { dose: mg, unit: 'mg', doses: 1 })], durationH: Math.max(hoursAfter + 0.5, 1) });
    const k = s.t.findIndex((t) => t >= hoursAfter);
    return ((s.series[drugId].conc[k >= 0 ? k : s.t.length - 1] ?? 0) / d.display.factor) * 1000;
  };
  let lo = 0.001, hi = 100000;
  for (let i = 0; i < 40; i++) {
    const mid = Math.sqrt(lo * hi);
    if (at(mid) < measuredNgMl) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

// ---------------------------------------------------------------------------
// Drug-supply twin: shortage-aware therapeutic substitution ranked by pharmacology and safety.

export interface Shortage {
  generic: string;
  status: string;
  category: string[];
  reason: string;
  updated: string;
  presentation: string;
}

export interface Substitute {
  drug: KBDrug;
  classOverlap: number;
  safetyDelta: number;
  inShortage: boolean;
}

export function currentShortages(shortages: Shortage[]): Shortage[] {
  return shortages.filter((s) => /current/i.test(s.status));
}

export function substitutesFor(name: string, kb: SafetyKB, shortages: Shortage[]): Substitute[] {
  const short = new Set(currentShortages(shortages).map((s) => s.generic.toLowerCase().split(/[ ,]/)[0]));
  const me = kb.drugs.find((d) => d.name === name || d.genericName.toLowerCase().startsWith(name));
  if (!me) return [];
  const severity = (d: KBDrug) => Object.values(d.organs).reduce((s, o) => s + (o.label === 2 ? 2 : o.label), 0);
  return kb.drugs
    .filter((d) => d.name !== me.name)
    .map((d) => ({ drug: d, classOverlap: jaccard(me.classes, d.classes), safetyDelta: severity(d) - severity(me), inShortage: short.has(d.name.split(' ')[0]) }))
    .filter((s) => s.classOverlap > 0)
    .sort((a, b) => b.classOverlap - a.classOverlap || a.safetyDelta - b.safetyDelta)
    .slice(0, 6);
}

/** Simulated dose of an alternative drug that matches the average exposure-to-target position of the original. */
export function equivalentDose(fromId: string, toId: string, p: Patient = defaultPatient()): { dose: number; note: string } | null {
  const a = getDrug(fromId);
  const b = getDrug(toId);
  if (!a.therapeutic || !b.therapeutic) return null;
  const pos = (drug: Drug, dose: number) => {
    const m = simulate({ patient: p, regimens: [makeRegimen(drug.id, { dose, doses: Math.round(120 / drug.defaultRegimen.intervalH) })], metricsOnly: true }).metrics[drug.id];
    return ((m.targetValue ?? 0) - drug.therapeutic!.low) / (drug.therapeutic!.high - drug.therapeutic!.low);
  };
  const target = pos(a, a.defaultRegimen.dose);
  let lo = b.defaultRegimen.dose * 0.05, hi = b.defaultRegimen.dose * 20;
  for (let i = 0; i < 25; i++) {
    const mid = Math.sqrt(lo * hi);
    if (pos(b, mid) < target) lo = mid;
    else hi = mid;
  }
  return { dose: Math.sqrt(lo * hi), note: `Matches the original regimen's position within its therapeutic range (${(target * 100).toFixed(0)}%).` };
}

