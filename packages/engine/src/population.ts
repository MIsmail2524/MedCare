import { getDrug } from './drugs.js';
import { defaultPatient, derivePhysiology } from './physiology.js';
import { simulate } from './pk.js';
import type { Eta } from './pk.js';
import type { Patient, Phenotype, Regimen } from './types.js';

/** Deterministic PRNG (mulberry32) so trials are reproducible from a seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const uniform = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare: number | null = null;
  const normal = () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = uniform();
    while (v === 0) v = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  const pick = <T extends string>(freq: Partial<Record<T, number>>): T => {
    const entries = Object.entries(freq) as [T, number][];
    const total = entries.reduce((s, [, f]) => s + f, 0);
    let x = uniform() * total;
    for (const [k, f] of entries) {
      x -= f;
      if (x <= 0) return k;
    }
    return entries[entries.length - 1][0];
  };
  return { uniform, normal, pick };
}

export type Ancestry = 'European' | 'East Asian' | 'African' | 'South Asian' | 'Latino' | 'Mixed';

/** Approximate phenotype frequencies summarised from CPIC/PharmGKB frequency tables. */
export const PHENOTYPE_FREQ: Record<Ancestry, {
  CYP2D6: Partial<Record<Phenotype, number>>;
  CYP2C19: Partial<Record<Phenotype, number>>;
  CYP2C9: Partial<Record<Phenotype, number>>;
  CYP3A5: Partial<Record<Phenotype, number>>;
  VKORC1: { GG: number; AG: number; AA: number };
}> = {
  European: {
    CYP2D6: { PM: 0.06, IM: 0.35, NM: 0.56, UM: 0.03 },
    CYP2C19: { PM: 0.02, IM: 0.26, NM: 0.4, RM: 0.27, UM: 0.05 },
    CYP2C9: { PM: 0.03, IM: 0.33, NM: 0.64 },
    CYP3A5: { NM: 0.01, IM: 0.14, PM: 0.85 },
    VKORC1: { GG: 0.37, AG: 0.47, AA: 0.16 },
  },
  'East Asian': {
    CYP2D6: { PM: 0.01, IM: 0.48, NM: 0.5, UM: 0.01 },
    CYP2C19: { PM: 0.13, IM: 0.46, NM: 0.38, RM: 0.03 },
    CYP2C9: { PM: 0.01, IM: 0.09, NM: 0.9 },
    CYP3A5: { NM: 0.09, IM: 0.4, PM: 0.51 },
    VKORC1: { GG: 0.02, AG: 0.18, AA: 0.8 },
  },
  African: {
    CYP2D6: { PM: 0.02, IM: 0.4, NM: 0.52, UM: 0.06 },
    CYP2C19: { PM: 0.04, IM: 0.33, NM: 0.37, RM: 0.23, UM: 0.03 },
    CYP2C9: { PM: 0.01, IM: 0.12, NM: 0.87 },
    CYP3A5: { NM: 0.45, IM: 0.42, PM: 0.13 },
    VKORC1: { GG: 0.8, AG: 0.18, AA: 0.02 },
  },
  'South Asian': {
    CYP2D6: { PM: 0.02, IM: 0.28, NM: 0.67, UM: 0.03 },
    CYP2C19: { PM: 0.08, IM: 0.42, NM: 0.33, RM: 0.15, UM: 0.02 },
    CYP2C9: { PM: 0.03, IM: 0.3, NM: 0.67 },
    CYP3A5: { NM: 0.1, IM: 0.4, PM: 0.5 },
    VKORC1: { GG: 0.5, AG: 0.4, AA: 0.1 },
  },
  Latino: {
    CYP2D6: { PM: 0.03, IM: 0.3, NM: 0.63, UM: 0.04 },
    CYP2C19: { PM: 0.01, IM: 0.25, NM: 0.52, RM: 0.19, UM: 0.03 },
    CYP2C9: { PM: 0.02, IM: 0.2, NM: 0.78 },
    CYP3A5: { NM: 0.05, IM: 0.3, PM: 0.65 },
    VKORC1: { GG: 0.25, AG: 0.45, AA: 0.3 },
  },
  Mixed: {
    CYP2D6: { PM: 0.04, IM: 0.36, NM: 0.56, UM: 0.04 },
    CYP2C19: { PM: 0.05, IM: 0.33, NM: 0.4, RM: 0.19, UM: 0.03 },
    CYP2C9: { PM: 0.02, IM: 0.2, NM: 0.78 },
    CYP3A5: { NM: 0.12, IM: 0.3, PM: 0.58 },
    VKORC1: { GG: 0.4, AG: 0.4, AA: 0.2 },
  },
};

export interface PopulationSpec {
  n: number;
  seed: number;
  ageMean: number;
  ageSd: number;
  ageMin: number;
  ageMax: number;
  femalePct: number;
  weightMean: number;
  weightSd: number;
  /** Median serum creatinine mg/dL (log-normal). */
  scrMedian: number;
  scrCv: number;
  ancestry: Ancestry;
  smokerPct: number;
  /** Fraction with hepatic impairment (Child-Pugh A/B). */
  hepaticImpairedPct: number;
}

export const DEFAULT_POPULATION: PopulationSpec = {
  n: 200,
  seed: 42,
  ageMean: 55,
  ageSd: 15,
  ageMin: 18,
  ageMax: 90,
  femalePct: 50,
  weightMean: 78,
  weightSd: 16,
  scrMedian: 0.95,
  scrCv: 0.3,
  ancestry: 'European',
  smokerPct: 15,
  hepaticImpairedPct: 5,
};

export interface VirtualSubject {
  patient: Patient;
  etas: Record<string, Eta>;
}

export function generatePopulation(spec: PopulationSpec, drugIds: string[]): VirtualSubject[] {
  const r = rng(spec.seed);
  const freq = PHENOTYPE_FREQ[spec.ancestry];
  const out: VirtualSubject[] = [];
  for (let i = 0; i < spec.n; i++) {
    const female = r.uniform() * 100 < spec.femalePct;
    const age = Math.min(spec.ageMax, Math.max(spec.ageMin, spec.ageMean + spec.ageSd * r.normal()));
    const height = (female ? 162 : 176) + 7 * r.normal();
    const weight = Math.max(40, (spec.weightMean + (female ? -7 : 7)) + spec.weightSd * r.normal());
    // Creatinine rises modestly with age; sex difference in muscle mass.
    const scr = spec.scrMedian * (female ? 0.85 : 1.05) * (1 + 0.004 * (age - 50)) * Math.exp(spec.scrCv * r.normal());
    const hep = r.uniform() * 100 < spec.hepaticImpairedPct;
    const patient = defaultPatient({
      name: `Subject ${i + 1}`,
      age: Math.round(age),
      sex: female ? 'female' : 'male',
      heightCm: Math.round(height),
      weightKg: Math.round(weight * 10) / 10,
      scr: Math.round(Math.max(0.4, scr) * 100) / 100,
      childPugh: hep ? (r.uniform() < 0.7 ? 'A' : 'B') : 'none',
      smoker: r.uniform() * 100 < spec.smokerPct,
      phenotypes: {
        CYP2D6: r.pick(freq.CYP2D6),
        CYP2C19: r.pick(freq.CYP2C19),
        CYP2C9: r.pick(freq.CYP2C9),
        CYP3A5: r.pick(freq.CYP3A5),
      },
      vkorc1: r.pick(freq.VKORC1),
    });
    const etas: Record<string, Eta> = Object.create(null);
    for (const id of drugIds) {
      const iiv = getDrug(id).pk.iiv ?? { CL: 0.3, V: 0.2, ka: 0.4 };
      // CV → log-normal SD: ω = sqrt(ln(1+CV²))
      const w = (cv: number) => Math.sqrt(Math.log(1 + cv * cv));
      etas[id] = { CL: w(iiv.CL) * r.normal(), V: w(iiv.V) * r.normal(), ka: w(iiv.ka) * r.normal() };
    }
    out.push({ patient, etas });
  }
  return out;
}

export interface TrialArm {
  id: string;
  label: string;
  regimens: Regimen[];
}

export interface ArmResult {
  armId: string;
  label: string;
  drugId: string;
  t: number[];
  percentiles: { p5: number[]; p25: number[]; p50: number[]; p75: number[]; p95: number[] };
  metric: { name: string; values: number[] };
  pta: number | null;
  pToxic: number | null;
  pBelow: number | null;
  summary: { cmaxMedian: number; troughMedian: number; auc24Median: number; cvAuc: number };
  subjects: { age: number; sex: string; weight: number; crcl: number; phenotype: string; metric: number; status: string }[];
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Run a virtual clinical trial: each arm is simulated across the same virtual population. */
export function runTrial(spec: PopulationSpec, arms: TrialArm[], primaryDrug: string, durationH?: number, onProgress?: (f: number) => void): ArmResult[] {
  const drugIds = Array.from(new Set(arms.flatMap((a) => a.regimens.map((r) => r.drugId))));
  const pop = generatePopulation(spec, drugIds);
  const drug = getDrug(primaryDrug);
  const results: ArmResult[] = [];
  const total = arms.length * pop.length;
  let done = 0;
  for (const arm of arms) {
    let dur = durationH ?? 0;
    if (!dur) for (const r of arm.regimens) dur = Math.max(dur, r.startH + r.doses * r.intervalH);
    const grid = Array.from({ length: 121 }, (_, i) => (dur * i) / 120);
    const curves: number[][] = [];
    const metricVals: number[] = [];
    const subjects: ArmResult['subjects'] = [];
    let ok = 0;
    let tox = 0;
    let below = 0;
    const cmax: number[] = [];
    const trough: number[] = [];
    const auc: number[] = [];
    for (const s of pop) {
      const phys = derivePhysiology(s.patient);
      const sim = simulate({ patient: s.patient, physiology: phys, regimens: arm.regimens, etas: s.etas, durationH: dur });
      const series = sim.series[primaryDrug];
      const m = sim.metrics[primaryDrug];
      if (!series || !m) continue;
      const conc = drug.prodrug && series.active ? series.active : series.conc;
      // interpolate onto grid
      const out: number[] = [];
      let k = 0;
      for (const g of grid) {
        while (k < sim.t.length - 2 && sim.t[k + 1] < g) k++;
        const t0 = sim.t[k];
        const t1 = sim.t[k + 1] ?? t0;
        const w = t1 > t0 ? (g - t0) / (t1 - t0) : 0;
        out.push(conc[k] + (conc[k + 1] - conc[k]) * Math.min(Math.max(w, 0), 1) || conc[k]);
      }
      curves.push(out);
      const mv = m.targetValue ?? m.avgLast;
      metricVals.push(mv);
      if (m.targetStatus === 'within') ok++;
      if (m.targetStatus === 'below') below++;
      if (m.toxicStatus === 'toxic') tox++;
      cmax.push(m.cmax);
      trough.push(m.troughLast);
      auc.push(m.auc24);
      subjects.push({
        age: s.patient.age,
        sex: s.patient.sex,
        weight: s.patient.weightKg,
        crcl: Math.round(phys.crcl),
        phenotype: Object.entries(s.patient.phenotypes).map(([k2, v]) => `${k2}:${v}`).join(' '),
        metric: mv,
        status: m.toxicStatus === 'toxic' ? 'toxic' : m.targetStatus,
      });
      done++;
      if (onProgress && done % 10 === 0) onProgress(done / total);
    }
    const pct = { p5: [] as number[], p25: [] as number[], p50: [] as number[], p75: [] as number[], p95: [] as number[] };
    grid.forEach((_, gi) => {
      const col = curves.map((c) => c[gi]).sort((a, b) => a - b);
      pct.p5.push(quantile(col, 0.05));
      pct.p25.push(quantile(col, 0.25));
      pct.p50.push(quantile(col, 0.5));
      pct.p75.push(quantile(col, 0.75));
      pct.p95.push(quantile(col, 0.95));
    });
    const sortedAuc = auc.slice().sort((a, b) => a - b);
    const mean = auc.reduce((s, v) => s + v, 0) / Math.max(auc.length, 1);
    const sd = Math.sqrt(auc.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(auc.length - 1, 1));
    const nSub = Math.max(curves.length, 1);
    results.push({
      armId: arm.id,
      label: arm.label,
      drugId: primaryDrug,
      t: grid,
      percentiles: pct,
      metric: { name: drug.therapeutic ? drug.therapeutic.basis : 'average', values: metricVals },
      pta: drug.therapeutic ? ok / nSub : null,
      pToxic: drug.toxic ? tox / nSub : null,
      pBelow: drug.therapeutic ? below / nSub : null,
      summary: {
        cmaxMedian: quantile(cmax.slice().sort((a, b) => a - b), 0.5),
        troughMedian: quantile(trough.slice().sort((a, b) => a - b), 0.5),
        auc24Median: quantile(sortedAuc, 0.5),
        cvAuc: mean > 0 ? sd / mean : 0,
      },
      subjects,
    });
  }
  onProgress?.(1);
  return results;
}
