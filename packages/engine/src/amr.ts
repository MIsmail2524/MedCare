import { getDrug } from './drugs.js';
import { generatePopulation, DEFAULT_POPULATION } from './population.js';
import { simulate } from './pk.js';
import type { Patient, Regimen } from './types.js';
import type { Eta } from './pk.js';

// Antimicrobial-resistance twin: links patient exposure to (1) probability of target attainment
// across a pathogen MIC distribution and (2) emergence of a resistant subpopulation during therapy
// (mutant-selection-window dynamics), so regimens are chosen to cure *and* not select resistance.

export interface BugDrug {
  id: string;
  drugId: string;
  organism: string;
  index: 'AUC/MIC' | 'Cmax/MIC';
  target: number;
  /** MIC distribution (mg/L → relative frequency), representative of EUCAST wild-type + resistant tails */
  mic: [number, number][];
  breakpoint: number;
  source: string;
}

export const BUG_DRUGS: BugDrug[] = [
  { id: 'sa-vanco', drugId: 'vancomycin', organism: 'Staphylococcus aureus (MRSA)', index: 'AUC/MIC', target: 400, breakpoint: 2, mic: [[0.25, 0.02], [0.5, 0.3], [1, 0.55], [2, 0.12], [4, 0.01]], source: 'EUCAST MIC distribution (vancomycin / S. aureus), ASHP/IDSA 2020 AUC/MIC target' },
  { id: 'ec-cipro', drugId: 'ciprofloxacin', organism: 'Escherichia coli', index: 'AUC/MIC', target: 125, breakpoint: 0.25, mic: [[0.008, 0.25], [0.015, 0.4], [0.03, 0.12], [0.06, 0.03], [0.25, 0.02], [1, 0.03], [8, 0.05], [32, 0.1]], source: 'EUCAST ciprofloxacin / E. coli distribution incl. resistant tail; AUC/MIC ≥ 125 (Forrest 1993)' },
  { id: 'pa-genta', drugId: 'gentamicin', organism: 'Pseudomonas aeruginosa', index: 'Cmax/MIC', target: 10, breakpoint: 4, mic: [[0.5, 0.1], [1, 0.35], [2, 0.3], [4, 0.13], [8, 0.07], [16, 0.05]], source: 'EUCAST gentamicin / P. aeruginosa; Cmax/MIC ≥ 8–10 (Moore 1987)' },
  { id: 'ca-fluc', drugId: 'fluconazole', organism: 'Candida albicans', index: 'AUC/MIC', target: 100, breakpoint: 4, mic: [[0.125, 0.25], [0.25, 0.4], [0.5, 0.2], [1, 0.08], [2, 0.03], [8, 0.02], [64, 0.02]], source: 'EUCAST fluconazole / C. albicans; AUC/MIC ≥ 100 (Andes 2003)' },
  { id: 'mtb-rif', drugId: 'rifampin', organism: 'Mycobacterium tuberculosis', index: 'AUC/MIC', target: 271, breakpoint: 0.5, mic: [[0.03, 0.15], [0.06, 0.35], [0.125, 0.3], [0.25, 0.12], [0.5, 0.05], [8, 0.03]], source: 'WHO TB MIC data; free AUC/MIC 271 (Jayaram 2003) — total-drug proxy' },
];

export interface PTAResult {
  bugDrug: BugDrug;
  byMic: { mic: number; pta: number }[];
  cfr: number;
  subjects: number;
}

/** Monte Carlo probability of target attainment and cumulative fraction of response. */
export function targetAttainment(bd: BugDrug, regimen: Regimen, n = 200, seed = 5, popOverrides: Partial<Patient> = {}): PTAResult {
  const pop = generatePopulation({ ...DEFAULT_POPULATION, n, seed }, [bd.drugId]);
  const idx: number[] = [];
  for (const s of pop) {
    const m = simulate({ patient: { ...s.patient, ...popOverrides }, regimens: [regimen], etas: s.etas, metricsOnly: true }).metrics[bd.drugId];
    idx.push(bd.index === 'AUC/MIC' ? m.auc24 : m.cmax);
  }
  const byMic = bd.mic.map(([mic]) => ({ mic, pta: idx.filter((v) => v / mic >= bd.target).length / idx.length }));
  const tot = bd.mic.reduce((s, [, f]) => s + f, 0);
  const cfr = bd.mic.reduce((s, [mic, f], i) => s + (f / tot) * byMic[i].pta, 0);
  return { bugDrug: bd, byMic, cfr, subjects: n };
}

export interface ResistanceResult {
  t: number[];
  conc: number[];
  susceptible: number[];
  resistant: number[];
  /** Fraction of time with concentration inside the mutant selection window [MIC, MPC] */
  mswFraction: number;
  pResistanceEmergence: number;
  cleared: boolean;
}

/**
 * Two-population bacterial dynamics driven by the twin's concentration curve:
 * dS/dt = g·S(1−N/Nmax) − kmax·Cʰ/(EC50sʰ+Cʰ)·S − μ·g·S ; dR/dt = g_r·R(1−N/Nmax) + μ·g·S − kill_R(C)·R
 * EC50 ≈ MIC (susceptible), MPC = 8×MIC for the first-step mutant (Drlica 2003).
 */
export function resistanceEmergence(patient: Patient, regimen: Regimen, mic: number, opts: { eta?: Eta; inoculum?: number; mutationRate?: number; mpcFold?: number } = {}): ResistanceResult {
  const sim = simulate({ patient, regimens: [regimen], etas: opts.eta ? { [regimen.drugId]: opts.eta } : undefined });
  const d = getDrug(regimen.drugId);
  const conc = sim.series[regimen.drugId].conc.map((c) => c / d.display.factor);
  const mpc = mic * (opts.mpcFold ?? 8);
  const g = 0.7; // h⁻¹ growth
  const gr = 0.6; // fitness cost
  const kmax = 2.5;
  const h = 2;
  const Nmax = 1e10;
  const mu = opts.mutationRate ?? 1e-8;
  let S = opts.inoculum ?? 1e8;
  let R = S * mu * 10;
  const outS: number[] = [];
  const outR: number[] = [];
  let msw = 0;
  for (let k = 0; k < sim.t.length; k++) {
    const dt = k ? sim.t[k] - sim.t[k - 1] : 0;
    const C = conc[k];
    if (k) {
      const sub = Math.max(1, Math.ceil(dt / 0.05));
      const hh = dt / sub;
      for (let j = 0; j < sub; j++) {
        const N = S + R;
        const killS = (kmax * C ** h) / (mic ** h + C ** h);
        const killR = (kmax * C ** h) / (mpc ** h + C ** h);
        const dS = g * S * (1 - N / Nmax) - killS * S - mu * g * S;
        const dR = gr * R * (1 - N / Nmax) + mu * g * S - killR * R;
        S = Math.max(S + hh * dS, 0);
        R = Math.max(R + hh * dR, 0);
        if (S < 1) S = 0;
        if (R < 1) R = R * 0.5; // stochastic extinction below one cell
      }
      if (C >= mic && C <= mpc) msw += dt;
    }
    outS.push(Math.log10(Math.max(S, 1)));
    outR.push(Math.log10(Math.max(R, 1)));
  }
  const dur = sim.durationH || 1;
  return {
    t: sim.t,
    conc: sim.series[regimen.drugId].conc,
    susceptible: outS,
    resistant: outR,
    mswFraction: msw / dur,
    pResistanceEmergence: 1 - Math.exp(-Math.max(R, 0) / 1e3),
    cleared: S < 10 && R < 10,
  };
}
