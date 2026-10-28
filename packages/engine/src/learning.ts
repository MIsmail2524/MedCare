import { getDrug } from './drugs.js';
import { derivePhysiology } from './physiology.js';
import { generatePopulation, rng, type PopulationSpec, DEFAULT_POPULATION } from './population.js';
import { makeRegimen, simulate, type Eta, type SimState } from './pk.js';
import { defaultAEModel, type AEModel } from './adverse.js';
import type { Patient, Regimen } from './types.js';

// ---------------------------------------------------------------------------
// 1. Cross-patient learning of population PK (empirical Bayes)
//
// Each recorded outcome with measured levels yields an individual MAP estimate (η_CL, η_V).
// Pooling those estimates shifts the population prior for future patients:
//   μ̂ = Σ η_i / n, applied with shrinkage n/(n + k) so early data cannot dominate.

export interface DrugPrior {
  n: number;
  sumCL: number;
  sumCL2: number;
  sumV: number;
  sumV2: number;
}

export interface LearnedModel {
  version: number;
  priors: Record<string, DrugPrior>;
  ae: AEModel;
  policies: Record<string, DosingPolicy>;
  outcomes: number;
  updatedAt: string | null;
}

export function emptyLearnedModel(): LearnedModel {
  return { version: 1, priors: {}, ae: defaultAEModel(), policies: {}, outcomes: 0, updatedAt: null };
}

export const PRIOR_SHRINKAGE_K = 5;

export function updatePrior(prior: DrugPrior | undefined, eta: Eta): DrugPrior {
  const p = prior ?? { n: 0, sumCL: 0, sumCL2: 0, sumV: 0, sumV2: 0 };
  return { n: p.n + 1, sumCL: p.sumCL + eta.CL, sumCL2: p.sumCL2 + eta.CL ** 2, sumV: p.sumV + eta.V, sumV2: p.sumV2 + eta.V ** 2 };
}

/** Population-shift η to apply for a new patient, shrunk toward zero. */
export function learnedEta(model: LearnedModel | null | undefined, drugId: string): Eta | null {
  const p = model?.priors[drugId];
  if (!p || p.n === 0) return null;
  const w = p.n / (p.n + PRIOR_SHRINKAGE_K);
  return { CL: (w * p.sumCL) / p.n, V: (w * p.sumV) / p.n, ka: 0 };
}

export function priorSummary(p: DrugPrior) {
  const mCL = p.sumCL / p.n;
  const mV = p.sumV / p.n;
  const sdCL = Math.sqrt(Math.max(p.sumCL2 / p.n - mCL ** 2, 0));
  const sdV = Math.sqrt(Math.max(p.sumV2 / p.n - mV ** 2, 0));
  const w = p.n / (p.n + PRIOR_SHRINKAGE_K);
  return { n: p.n, clFactor: Math.exp(w * mCL), vFactor: Math.exp(w * mV), sdCL, sdV, weight: w };
}

/** Learned η for every drug (to pass as `etas` to simulate). */
export function learnedEtas(model: LearnedModel | null | undefined, drugIds: string[]): Record<string, Eta> | undefined {
  if (!model) return undefined;
  const out: Record<string, Eta> = Object.create(null);
  let any = false;
  for (const id of drugIds) {
    const e = learnedEta(model, id);
    if (e) {
      out[id] = e;
      any = true;
    }
  }
  return any ? out : undefined;
}

// ---------------------------------------------------------------------------
// 2. Reinforcement learning for dose titration (tabular Q-learning)
//
// MDP: a clinician adjusts a maintenance dose over K titration steps.
//  state  = patient context (renal × weight × age × pharmacogenomic activity) × last observed exposure
//  action = dose multiplier relative to the standard regimen
//  reward = +1 in target, penalties for sub-therapeutic, supratherapeutic and toxic exposure,
//           small cost for large dose changes
// The agent is pre-trained in silico on virtual patients from the digital-twin simulator, then
// reinforced with real recorded outcomes (state, action, observed exposure) for future patients.

export const RL_ACTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
export const RL_STATUSES = ['none', 'below', 'within', 'above', 'toxic'] as const;
export type RLStatus = (typeof RL_STATUSES)[number];
const RENAL_BANDS = [30, 60, 90];
const WEIGHT_BANDS = [60, 90];
const AGE_BANDS = [40, 65];
export const RL_STATE_COUNT = 4 * 3 * 3 * 3 * RL_STATUSES.length;
export const RL_STEPS = 4;

export interface DosingPolicy {
  drugId: string;
  q: number[];
  counts: number[];
  episodes: number;
  realUpdates: number;
  trainedAt: string;
  rewardCurve: number[];
  evaluation?: PolicyEvaluation;
}

export interface PolicyEvaluation {
  subjects: number;
  policy: { pta: number; toxic: number; meanReward: number };
  standard: { pta: number; toxic: number; meanReward: number };
}

export const RL_ELIGIBLE = ['vancomycin', 'gentamicin', 'phenytoin', 'theophylline', 'lithium', 'digoxin', 'tacrolimus', 'valproate', 'carbamazepine', 'lamotrigine', 'enoxaparin', 'warfarin'];

const band = (v: number, edges: number[]) => {
  let i = 0;
  while (i < edges.length && v >= edges[i]) i++;
  return i;
};

export function pgxBand(drugId: string, patient: Patient): number {
  const d = getDrug(drugId);
  const phys = derivePhysiology(patient);
  const main = d.metabolism.slice().sort((a, b) => b.fm - a.fm)[0];
  if (!main || d.pk.fe > 0.6) return 1;
  const act = phys.enzymeActivity[main.pathway] + (main.pathway === 'CYP3A4' ? phys.enzymeActivity.CYP3A5 * 0.5 : 0);
  return act < 0.6 ? 0 : act > 1.3 ? 2 : 1;
}

export function stateIndex(drugId: string, patient: Patient, status: RLStatus): number {
  const phys = derivePhysiology(patient);
  const r = band(phys.crcl, RENAL_BANDS);
  const w = band(patient.weightKg, WEIGHT_BANDS);
  const a = band(patient.age, AGE_BANDS);
  const g = pgxBand(drugId, patient);
  const s = RL_STATUSES.indexOf(status);
  return ((((r * 3 + w) * 3 + a) * 3 + g) * RL_STATUSES.length) + s;
}

export function describeState(idx: number): { renal: string; weight: string; age: string; pgx: string; status: RLStatus } {
  const s = idx % RL_STATUSES.length;
  let rest = Math.floor(idx / RL_STATUSES.length);
  const g = rest % 3;
  rest = Math.floor(rest / 3);
  const a = rest % 3;
  rest = Math.floor(rest / 3);
  const w = rest % 3;
  const r = Math.floor(rest / 3);
  return {
    renal: ['CrCl < 30', 'CrCl 30–59', 'CrCl 60–89', 'CrCl ≥ 90'][r],
    weight: ['< 60 kg', '60–89 kg', '≥ 90 kg'][w],
    age: ['< 40 y', '40–64 y', '≥ 65 y'][a],
    pgx: ['low metabolic activity', 'normal activity', 'high metabolic activity'][g],
    status: RL_STATUSES[s],
  };
}

export function rewardFor(status: RLStatus, prevMult: number, mult: number): number {
  const base = status === 'within' ? 1 : status === 'below' ? -0.6 : status === 'above' ? -1 : status === 'toxic' ? -3 : 0;
  return base - 0.08 * Math.abs(Math.log(mult / prevMult));
}

function segmentHours(drugId: string): number {
  const d = getDrug(drugId);
  const iv = d.defaultRegimen.intervalH;
  const t12 = d.pk.mm ? 72 : (0.693 * (d.pk.Vc + (d.pk.Vp ?? 0)) * 70) / Math.max(d.pk.CL, 1e-6);
  const h = Math.min(Math.max(4 * t12, 48), 240);
  return Math.ceil(h / iv) * iv;
}

/** Environment step: give `mult × standard` for one segment, observe exposure status. */
export function envStep(drugId: string, patient: Patient, eta: Eta, mult: number, initial?: SimState): { status: RLStatus; next: SimState; value: number | null } {
  const d = getDrug(drugId);
  const base = makeRegimen(drugId);
  const seg = segmentHours(drugId);
  const reg: Regimen = { ...base, id: 'rl', dose: base.dose * mult, doses: Math.max(1, Math.round(seg / base.intervalH)), loadingDose: undefined };
  const sim = simulate({ patient, regimens: [reg], durationH: seg, etas: { [drugId]: eta }, initial, metricsOnly: true });
  const m = sim.metrics[drugId];
  const status: RLStatus = m.toxicStatus === 'toxic' ? 'toxic' : m.targetStatus === 'within' ? 'within' : m.targetStatus === 'above' ? 'above' : m.targetStatus === 'below' ? 'below' : 'within';
  void d;
  return { status, next: sim.finalState, value: m.targetValue };
}

export function newPolicy(drugId: string): DosingPolicy {
  const q = new Array(RL_STATE_COUNT * RL_ACTIONS.length).fill(0);
  // Mild prior toward the standard dose so untrained states default to it.
  for (let s = 0; s < RL_STATE_COUNT; s++) q[s * RL_ACTIONS.length + RL_ACTIONS.indexOf(1)] = 0.05;
  return { drugId, q, counts: new Array(RL_STATE_COUNT * RL_ACTIONS.length).fill(0), episodes: 0, realUpdates: 0, trainedAt: new Date().toISOString(), rewardCurve: [] };
}

function greedy(policy: DosingPolicy, s: number): number {
  let best = 0;
  for (let a = 1; a < RL_ACTIONS.length; a++) if (policy.q[s * RL_ACTIONS.length + a] > policy.q[s * RL_ACTIONS.length + best]) best = a;
  return best;
}

export interface TrainOptions {
  episodes?: number;
  alpha?: number;
  gamma?: number;
  seed?: number;
  population?: Partial<PopulationSpec>;
  onProgress?: (fraction: number, meanReward: number) => void;
}

/** In-silico Q-learning on virtual patients drawn from the twin population model. */
export function trainDosingPolicy(drugId: string, start: DosingPolicy | null, opts: TrainOptions = {}): DosingPolicy {
  const episodes = opts.episodes ?? 500;
  const alpha = opts.alpha ?? 0.2;
  const gamma = opts.gamma ?? 0.7;
  const r = rng(opts.seed ?? 7);
  const policy: DosingPolicy = start ? { ...start, q: start.q.slice(), counts: start.counts.slice(), rewardCurve: start.rewardCurve.slice() } : newPolicy(drugId);
  const pop = generatePopulation({ ...DEFAULT_POPULATION, ...opts.population, n: episodes, seed: (opts.seed ?? 7) * 31 + policy.episodes }, [drugId]);
  const A = RL_ACTIONS.length;
  let windowSum = 0;
  for (let e = 0; e < episodes; e++) {
    const subj = pop[e];
    const eps = Math.max(0.05, 1 - (policy.episodes + e) / (episodes * 0.7 + policy.episodes));
    let status: RLStatus = 'none';
    let state: SimState | undefined;
    let prev = 1;
    let total = 0;
    for (let k = 0; k < RL_STEPS; k++) {
      const s = stateIndex(drugId, subj.patient, status);
      const a = r.uniform() < eps ? Math.floor(r.uniform() * A) : greedy(policy, s);
      const mult = RL_ACTIONS[a];
      const step = envStep(drugId, subj.patient, subj.etas[drugId], mult, state);
      const rew = rewardFor(step.status, prev, mult);
      const s2 = stateIndex(drugId, subj.patient, step.status);
      const terminal = k === RL_STEPS - 1;
      const target = rew + (terminal ? 0 : gamma * policy.q[s2 * A + greedy(policy, s2)]);
      const idx = s * A + a;
      policy.q[idx] += alpha * (target - policy.q[idx]);
      policy.counts[idx] += 1;
      total += rew;
      status = step.status;
      state = step.next;
      prev = mult;
    }
    windowSum += total;
    if ((e + 1) % 25 === 0) {
      policy.rewardCurve.push(windowSum / 25);
      opts.onProgress?.((e + 1) / episodes, windowSum / 25);
      windowSum = 0;
    }
  }
  policy.episodes += episodes;
  policy.trainedAt = new Date().toISOString();
  return policy;
}

/** Compare the learned policy with fixed standard dosing on held-out virtual patients. */
export function evaluatePolicy(policy: DosingPolicy, subjects = 60, seed = 9001): PolicyEvaluation {
  const drugId = policy.drugId;
  const pop = generatePopulation({ ...DEFAULT_POPULATION, n: subjects, seed }, [drugId]);
  const run = (choose: (s: number) => number) => {
    let ok = 0;
    let tox = 0;
    let reward = 0;
    for (const subj of pop) {
      let status: RLStatus = 'none';
      let state: SimState | undefined;
      let prev = 1;
      for (let k = 0; k < RL_STEPS; k++) {
        const mult = RL_ACTIONS[choose(stateIndex(drugId, subj.patient, status))];
        const step = envStep(drugId, subj.patient, subj.etas[drugId], mult, state);
        reward += rewardFor(step.status, prev, mult);
        status = step.status;
        state = step.next;
        prev = mult;
      }
      if (status === 'within') ok++;
      if (status === 'toxic') tox++;
    }
    return { pta: ok / subjects, toxic: tox / subjects, meanReward: reward / subjects };
  };
  return {
    subjects,
    policy: run((s) => greedy(policy, s)),
    standard: run(() => RL_ACTIONS.indexOf(1)),
  };
}

export interface PolicyRecommendation {
  stateIndex: number;
  state: ReturnType<typeof describeState>;
  ranked: { multiplier: number; q: number; visits: number }[];
  best: { multiplier: number; q: number; visits: number };
  confidence: 'low' | 'medium' | 'high';
}

export function recommendFromPolicy(policy: DosingPolicy, patient: Patient, lastStatus: RLStatus): PolicyRecommendation {
  const s = stateIndex(policy.drugId, patient, lastStatus);
  const A = RL_ACTIONS.length;
  const ranked = RL_ACTIONS.map((m, a) => ({ multiplier: m, q: policy.q[s * A + a], visits: policy.counts[s * A + a] })).sort((x, y) => y.q - x.q);
  const visits = ranked.reduce((acc, x) => acc + x.visits, 0);
  return { stateIndex: s, state: describeState(s), ranked, best: ranked[0], confidence: visits >= 40 ? 'high' : visits >= 10 ? 'medium' : 'low' };
}

/** Reinforce the policy with a real observed transition (higher learning rate than simulation). */
export function reinforcePolicy(policy: DosingPolicy, patient: Patient, prevStatus: RLStatus, multiplier: number, observed: RLStatus, alpha = 0.5): DosingPolicy {
  const A = RL_ACTIONS.length;
  let a = RL_ACTIONS.indexOf(multiplier);
  if (a < 0) a = RL_ACTIONS.reduce((best, m, i) => (Math.abs(Math.log(m / multiplier)) < Math.abs(Math.log(RL_ACTIONS[best] / multiplier)) ? i : best), 0);
  const s = stateIndex(policy.drugId, patient, prevStatus);
  const rew = rewardFor(observed, 1, RL_ACTIONS[a]);
  const q = policy.q.slice();
  const counts = policy.counts.slice();
  q[s * A + a] += alpha * (rew - q[s * A + a]);
  counts[s * A + a] += 1;
  return { ...policy, q, counts, realUpdates: policy.realUpdates + 1 };
}

/** Compact, JSON-safe policy (rounded) for storage. */
export function serializePolicy(p: DosingPolicy): DosingPolicy {
  return { ...p, q: p.q.map((v) => Math.round(v * 1000) / 1000), rewardCurve: p.rewardCurve.map((v) => Math.round(v * 1000) / 1000) };
}

export function statusFromMetric(drugId: string, value: number): RLStatus {
  const d = getDrug(drugId);
  if (!d.therapeutic) return 'within';
  if (d.toxic && d.toxic.basis === d.therapeutic.basis && value > d.toxic.value) return 'toxic';
  return value < d.therapeutic.low ? 'below' : value > d.therapeutic.high ? 'above' : 'within';
}
