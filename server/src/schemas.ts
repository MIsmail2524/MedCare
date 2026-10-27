import { z } from 'zod';
import { DRUG_MAP, PROCEDURE_MAP } from '@medcare/engine';

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const text = (max: number) => z.string().trim().max(max);
const isoDate = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
const drugId = z.string().max(40).refine((s) => Object.hasOwn(DRUG_MAP, s), 'Unknown drug');
const phenotype = z.enum(['PM', 'IM', 'NM', 'RM', 'UM']);
const route = z.enum(['po', 'iv_bolus', 'iv_infusion', 'sc']);
const doseUnit = z.enum(['mg', 'mg/kg', 'mg/m2']);

export const email = z.email().max(254).transform((s) => s.toLowerCase());

export const registerSchema = z.object({
  email,
  name: text(80).min(1),
  password: z.string().min(1).max(128),
  role: z.enum(['student', 'clinician', 'researcher']).default('student'),
  organisation: text(120).optional(),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(1).max(128),
});

export const profileSchema = z.object({ name: text(80).min(1), organisation: text(120).optional() });

export const totpCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const regimenSchema = z.object({
  id: id,
  drugId,
  dose: z.number().positive().max(100000),
  unit: doseUnit,
  intervalH: z.number().min(0.25).max(24 * 60),
  route,
  infusionH: z.number().min(1 / 60).max(72).optional(),
  startH: z.number().min(0).max(24 * 365),
  doses: z.number().int().min(1).max(2000),
  loadingDose: z.number().positive().max(100000).optional(),
});

export const patientSchema = z.object({
  name: text(80).min(1),
  age: z.number().min(0.1).max(120),
  sex: z.enum(['male', 'female']),
  weightKg: z.number().min(1).max(400),
  heightCm: z.number().min(40).max(250),
  scr: z.number().min(0.1).max(20),
  albumin: z.number().min(1).max(6.5),
  potassium: z.number().min(1.5).max(9),
  baselineQTc: z.number().min(300).max(650).optional(),
  baselineHR: z.number().min(20).max(220).optional(),
  baselineSBP: z.number().min(50).max(260).optional(),
  childPugh: z.enum(['none', 'A', 'B', 'C']),
  phenotypes: z.object({ CYP2D6: phenotype, CYP2C19: phenotype, CYP2C9: phenotype, CYP3A5: phenotype }),
  vkorc1: z.enum(['GG', 'AG', 'AA']),
  hla: z.object({ B1502: z.boolean(), B5701: z.boolean(), B5801: z.boolean() }),
  smoker: z.boolean(),
  alcoholUse: z.enum(['none', 'moderate', 'heavy']),
  pregnant: z.boolean(),
  heartFailure: z.boolean(),
  conditions: z.array(z.object({ id, name: text(120).min(1), since: isoDate.optional(), notes: text(500).optional() })).max(100),
  allergies: z.array(text(60)).max(50),
  procedures: z
    .array(z.object({ id, type: z.string().max(40).refine((s) => Object.hasOwn(PROCEDURE_MAP, s), 'Unknown procedure'), date: isoDate, notes: text(500).optional() }))
    .max(100),
  medicationHistory: z
    .array(
      z.object({
        id,
        drugId,
        dose: z.number().positive().max(100000),
        unit: doseUnit,
        intervalH: z.number().min(0.25).max(24 * 60),
        route,
        infusionH: z.number().min(1 / 60).max(72).optional(),
        start: isoDate,
        end: isoDate,
        notes: text(500).optional(),
      }),
    )
    .max(200),
  labs: z.array(z.object({ id, date: isoDate, drugId, value: z.number().min(0).max(1e6) })).max(500),
});

export const twinSchema = z.object({ name: text(80).min(1), data: patientSchema });

export const simulateSchema = z.object({
  patient: patientSchema,
  regimens: z.array(regimenSchema).min(1).max(8),
  durationH: z.number().min(1).max(24 * 90).optional(),
});

export const savedSimulationSchema = z.object({
  name: text(120).min(1),
  kind: z.enum(['simulation', 'trial', 'tdm', 'anesthesia', 'discovery']),
  twinId: id.optional(),
  // Configuration and summary are opaque JSON for re-running; bounded by body size and depth.
  config: z.record(z.string(), z.unknown()),
  summary: z.record(z.string(), z.unknown()),
});

export const compoundSchema = z.object({
  name: text(120).min(1),
  mw: z.number().min(10).max(5000),
  logP: z.number().min(-10).max(15),
  hbd: z.number().int().min(0).max(50),
  hba: z.number().int().min(0).max(50),
  tpsa: z.number().min(0).max(1000),
  rotatableBonds: z.number().int().min(0).max(100),
  solubility: z.number().positive().max(1000),
  permeability: z.number().min(0).max(1000),
  fu: z.number().min(0.0001).max(1),
  species: z.enum(['mouse', 'rat', 'rabbit', 'dog', 'monkey', 'minipig']),
  noaelMgKg: z.number().positive().max(10000),
  animalCL_mLminKg: z.number().positive().max(1000),
  animalVss_Lkg: z.number().positive().max(500),
  targetConc: z.number().positive().max(10000),
  safetyFactor: z.number().min(1).max(1000),
  F: z.number().min(0.001).max(1),
  ka: z.number().positive().max(50),
});

export const attemptSchema = z.object({
  caseId: z.string().max(64),
  answers: z.record(z.string().max(16), z.number().int().min(0).max(10)),
});

export const adminUserPatch = z.object({
  role: z.enum(['student', 'clinician', 'researcher', 'admin']).optional(),
  disabled: z.boolean().optional(),
});
