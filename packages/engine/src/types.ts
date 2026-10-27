// Core domain types for the MedCare physiology engine.
// Internal units: amount mg, volume L, concentration mg/L, time h.

export type Route = 'po' | 'iv_bolus' | 'iv_infusion' | 'sc';
export type DoseUnit = 'mg' | 'mg/kg' | 'mg/m2';
export type Pathway =
  | 'CYP3A4'
  | 'CYP3A5'
  | 'CYP2D6'
  | 'CYP2C9'
  | 'CYP2C19'
  | 'CYP1A2'
  | 'CYP2B6'
  | 'CYP2E1'
  | 'UGT'
  | 'Pgp';
export type Strength = 'strong' | 'moderate' | 'weak';
export type Phenotype = 'PM' | 'IM' | 'NM' | 'RM' | 'UM';
export type Organ =
  | 'brain'
  | 'thyroid'
  | 'heart'
  | 'lungs'
  | 'liver'
  | 'pancreas'
  | 'gi'
  | 'kidneys'
  | 'blood'
  | 'muscle'
  | 'skin';
export type ExposureBasis = 'trough' | 'peak' | 'average' | 'auc24';
export type RiskFlag = 'qt' | 'serotonergic' | 'cnsDepressant' | 'bleeding' | 'nephrotoxic' | 'hepatotoxic' | 'hyperkalemia';

export interface Target {
  low: number;
  high: number;
  basis: ExposureBasis;
}

export interface DrugPK {
  /** Oral bioavailability (0-1). */
  F: number;
  /** First-order absorption rate constant, 1/h. */
  ka: number;
  /** Absorption lag time, h. */
  tlag?: number;
  /** Total clearance for a 70 kg adult with CrCl 100 mL/min, normal enzymes, L/h. */
  CL: number;
  /** Central volume, L/kg. */
  Vc: number;
  /** Peripheral volume, L/kg (two-compartment drugs). */
  Vp?: number;
  /** Inter-compartmental clearance, L/h (70 kg). */
  Q?: number;
  /** Fraction of clearance that is renal (scaled by CrCl). */
  fe: number;
  /** Share of renal clearance mediated by P-gp tubular secretion. */
  renalPgpShare?: number;
  /** Plasma fraction unbound. */
  fu: number;
  /** Michaelis-Menten elimination (replaces linear CL). Vmax mg/kg/day, Km mg/L. */
  mm?: { Vmax: number; Km: number };
  /** Body size descriptor for volume scaling. */
  vScale: 'TBW' | 'IBW' | 'ABW' | 'LBW';
  /** Inter-individual variability as CV fraction. */
  iiv?: { CL: number; V: number; ka: number };
}

export interface PDModel {
  effect: string;
  unit: string;
  /** Baseline. */
  E0: number;
  /** Maximum change from baseline (sign = direction). */
  Emax: number;
  /** Effect-site concentration giving half-maximal effect, mg/L. */
  EC50: number;
  hill: number;
  /** Effect-compartment equilibration rate, 1/h. */
  ke0: number;
}

export interface OrganEffect {
  organ: Organ;
  kind: 'target' | 'adverse';
  note: string;
}

export interface Drug {
  id: string;
  name: string;
  brands: string[];
  drugClass: string;
  category: string;
  mechanism: string;
  indications: string[];
  routes: Route[];
  defaultRegimen: { dose: number; unit: DoseUnit; intervalH: number; route: Route; infusionH?: number };
  doseStep: number;
  pk: DrugPK;
  /** Converts internal mg/L of the dosed form to the display unit. */
  display: { unit: string; factor: number };
  therapeutic?: Target;
  toxic?: { value: number; basis: ExposureBasis; note: string };
  metabolism: { pathway: Pathway; fm: number }[];
  inhibits: { pathway: Pathway; strength: Strength }[];
  induces: { pathway: Pathway; strength: Strength }[];
  prodrug?: { pathway: Pathway; share: number; activeMoiety: string };
  qt: { risk: 'known' | 'possible' | 'conditional' | 'none'; maxMs: number };
  flags: RiskFlag[];
  pd?: PDModel;
  organs: OrganEffect[];
  cumulativeLimit?: { value: number; unit: 'mg/m2' | 'mg/kg' | 'mg'; organ: Organ; note: string };
  renal?: string;
  hepatic?: string;
  pgx?: string;
  pregnancy?: string;
  boxedWarning?: string;
  monitoring: string[];
  references: string[];
}

export interface ProcedureRecord {
  id: string;
  type: string;
  date: string; // ISO date
  notes?: string;
}

export interface MedicationCourse {
  id: string;
  drugId: string;
  dose: number;
  unit: DoseUnit;
  intervalH: number;
  route: Route;
  infusionH?: number;
  start: string; // ISO date-time
  end: string; // ISO date-time
  notes?: string;
}

export interface ConditionRecord {
  id: string;
  name: string;
  since?: string;
  notes?: string;
}

export interface LabRecord {
  id: string;
  date: string;
  drugId: string;
  /** Concentration in the drug's display unit. */
  value: number;
}

export interface Patient {
  name: string;
  age: number;
  sex: 'male' | 'female';
  weightKg: number;
  heightCm: number;
  /** Serum creatinine, mg/dL. */
  scr: number;
  /** Serum albumin, g/dL. */
  albumin: number;
  potassium: number;
  baselineQTc?: number;
  baselineHR?: number;
  baselineSBP?: number;
  childPugh: 'none' | 'A' | 'B' | 'C';
  phenotypes: { CYP2D6: Phenotype; CYP2C19: Phenotype; CYP2C9: Phenotype; CYP3A5: Phenotype };
  vkorc1: 'GG' | 'AG' | 'AA';
  hla: { B1502: boolean; B5701: boolean; B5801: boolean };
  smoker: boolean;
  alcoholUse: 'none' | 'moderate' | 'heavy';
  pregnant: boolean;
  heartFailure: boolean;
  conditions: ConditionRecord[];
  allergies: string[];
  procedures: ProcedureRecord[];
  medicationHistory: MedicationCourse[];
  labs: LabRecord[];
}

export interface Regimen {
  id: string;
  drugId: string;
  dose: number;
  unit: DoseUnit;
  intervalH: number;
  route: Route;
  infusionH?: number;
  /** Start offset from simulation start, h. */
  startH: number;
  /** Number of doses. */
  doses: number;
  /** Optional loading dose (same unit) given as first dose. */
  loadingDose?: number;
}

export interface Physiology {
  bmi: number;
  bsa: number;
  ibw: number;
  abw: number;
  lbw: number;
  crcl: number;
  crclWeight: 'TBW' | 'IBW' | 'ABW';
  egfr: number;
  ckdStage: string;
  hepaticFactor: number;
  absorptionFactor: number;
  volumeFactor: number;
  renalFactor: number;
  baselineQTc: number;
  baselineHR: number;
  baselineSBP: number;
  enzymeActivity: Record<Pathway, number>;
  notes: string[];
}

export interface IndividualParams {
  CL: number;
  Vc: number;
  Vp: number;
  Q: number;
  ka: number;
  F: number;
  tlag: number;
  vmax?: number; // mg/h
  km?: number;
  /** Fraction of CL by each pathway (pre-DDI), for dynamic modulation. */
  shares: { renal: number; renalPgp: number; pathways: { pathway: Pathway; f: number }[]; other: number };
}

export interface Alert {
  severity: 'info' | 'moderate' | 'major' | 'contraindicated';
  title: string;
  detail: string;
  drugs: string[];
  category: 'interaction' | 'pgx' | 'renal' | 'hepatic' | 'exposure' | 'qt' | 'pregnancy' | 'allergy' | 'history' | 'cumulative';
  action?: string;
}
