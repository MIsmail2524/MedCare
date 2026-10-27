import { getDrug } from './drugs.js';
import { derivePhysiology } from './physiology.js';
import { referenceConcentration, simulate } from './pk.js';
import type { Eta, SimState } from './pk.js';
import type { Patient, Regimen } from './types.js';

export interface DoseRecommendation {
  drugId: string;
  currentDose: number;
  recommendedDose: number;
  unit: string;
  intervalH: number;
  predictedValue: number;
  targetLow: number;
  targetHigh: number;
  basis: string;
  rationale: string;
}

function roundTo(x: number, step: number): number {
  return Math.max(step, Math.round(x / step) * step);
}

/**
 * Find the dose (same interval) that brings the therapeutic metric to the centre of its range,
 * accounting for co-medication and non-linear kinetics, by bisection on re-simulation.
 */
export function recommendDose(
  patient: Patient,
  regimens: Regimen[],
  drugId: string,
  opts: { etas?: Record<string, Eta>; durationH?: number; initial?: SimState } = {},
): DoseRecommendation | null {
  const drug = getDrug(drugId);
  if (!drug.therapeutic) return null;
  const idx = regimens.findIndex((r) => r.drugId === drugId);
  if (idx < 0) return null;
  const base = regimens[idx];
  const phys = derivePhysiology(patient);
  const { low, high, basis } = drug.therapeutic;
  const target = basis === 'trough' && drug.toxic?.basis === 'trough' ? low + (Math.min(high, drug.toxic.value) - low) * 0.5 : (low + high) / 2;

  const evalDose = (dose: number) => {
    const regs = regimens.map((r, i) => (i === idx ? { ...r, dose, loadingDose: r.loadingDose ? (r.loadingDose * dose) / base.dose : undefined } : r));
    const sim = simulate({ patient, physiology: phys, regimens: regs, etas: opts.etas, durationH: opts.durationH, initial: opts.initial, metricsOnly: true });
    return sim.metrics[drugId].targetValue ?? 0;
  };
  const current = evalDose(base.dose);
  if (current >= low && current <= high) {
    return {
      drugId, currentDose: base.dose, recommendedDose: base.dose, unit: base.unit, intervalH: base.intervalH,
      predictedValue: current, targetLow: low, targetHigh: high, basis,
      rationale: `Predicted ${basis} is within the target range; no change required.`,
    };
  }
  // bracket
  let lo = base.dose * 0.05;
  let hi = base.dose * 20;
  for (let i = 0; i < 28; i++) {
    const mid = Math.sqrt(lo * hi);
    if (evalDose(mid) < target) lo = mid;
    else hi = mid;
  }
  const raw = Math.sqrt(lo * hi);
  const step = base.unit === 'mg' ? drug.doseStep : base.unit === 'mg/kg' ? 0.5 : 5;
  const rec = roundTo(raw, step);
  const predicted = evalDose(rec);
  const nonlinear = !!drug.pk.mm;
  return {
    drugId, currentDose: base.dose, recommendedDose: rec, unit: base.unit, intervalH: base.intervalH,
    predictedValue: predicted, targetLow: low, targetHigh: high, basis,
    rationale:
      `Current regimen predicts ${basis} ${current.toPrecision(3)} (target ${low}–${high}). ` +
      `${rec > base.dose ? 'Increase' : 'Decrease'} to ${rec} ${base.unit} q${base.intervalH}h → predicted ${predicted.toPrecision(3)}.` +
      (nonlinear ? ' Note: Michaelis–Menten kinetics — small dose changes cause disproportionate concentration changes.' : ''),
  };
}

// ---------------------------------------------------------------------------
// Nelder–Mead simplex minimiser

export function nelderMead(f: (x: number[]) => number, x0: number[], opts: { maxIter?: number; step?: number; tol?: number } = {}): { x: number[]; fx: number; iterations: number } {
  const n = x0.length;
  const maxIter = opts.maxIter ?? 300;
  const step = opts.step ?? 0.3;
  const tol = opts.tol ?? 1e-6;
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] += step;
    simplex.push(p);
  }
  let values = simplex.map(f);
  let it = 0;
  for (; it < maxIter; it++) {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    simplex = order.map(([, i]) => simplex[i]);
    values = order.map(([v]) => v);
    if (Math.abs(values[n] - values[0]) < tol) break;
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const worst = simplex[n];
    const refl = centroid.map((c, j) => c + (c - worst[j]));
    const fr = f(refl);
    if (fr < values[0]) {
      const exp = centroid.map((c, j) => c + 2 * (c - worst[j]));
      const fe = f(exp);
      if (fe < fr) {
        simplex[n] = exp;
        values[n] = fe;
      } else {
        simplex[n] = refl;
        values[n] = fr;
      }
    } else if (fr < values[n - 1]) {
      simplex[n] = refl;
      values[n] = fr;
    } else {
      const con = centroid.map((c, j) => c + 0.5 * (worst[j] - c));
      const fc = f(con);
      if (fc < values[n]) {
        simplex[n] = con;
        values[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          values[i] = f(simplex[i]);
        }
      }
    }
  }
  return { x: simplex[0], fx: values[0], iterations: it };
}

// ---------------------------------------------------------------------------
// Bayesian maximum a posteriori (MAP) estimation for therapeutic drug monitoring

export interface Observation {
  /** Time after the first dose, h. */
  timeH: number;
  /** Concentration in display units. */
  value: number;
}

export interface BayesResult {
  eta: Eta;
  individual: { CL: number; V: number; halfLifeH: number };
  population: { CL: number; V: number; halfLifeH: number };
  objective: number;
  fitted: { timeH: number; observed: number; predicted: number; populationPredicted: number }[];
  /** Approximate 90% credible interval for CL from the curvature of the objective. */
  clInterval: [number, number];
  shrinkageNote: string;
}

function predictAt(t: number[], c: number[], time: number): number {
  if (time <= t[0]) return c[0];
  for (let i = 1; i < t.length; i++) {
    if (t[i] >= time) {
      const w = (time - t[i - 1]) / (t[i] - t[i - 1] || 1);
      return c[i - 1] + w * (c[i] - c[i - 1]);
    }
  }
  return c[c.length - 1];
}

/**
 * MAP Bayesian estimation of individual CL and V from measured levels, using population priors
 * (log-normal IIV) and a combined proportional + additive residual error model.
 */
export function bayesianEstimate(patient: Patient, regimens: Regimen[], drugId: string, observations: Observation[], opts: { propErr?: number; addErr?: number } = {}): BayesResult {
  const drug = getDrug(drugId);
  const iiv = drug.pk.iiv ?? { CL: 0.3, V: 0.2, ka: 0.4 };
  const wCL = Math.sqrt(Math.log(1 + iiv.CL ** 2));
  const wV = Math.sqrt(Math.log(1 + iiv.V ** 2));
  const prop = opts.propErr ?? 0.15;
  // additive error: 5% of the typical steady-state concentration, in display units
  const add = opts.addErr ?? referenceConcentration(drug) * drug.display.factor * 0.05;
  const phys = derivePhysiology(patient);
  const lastObs = Math.max(...observations.map((o) => o.timeH));
  let dur = 0;
  for (const r of regimens) dur = Math.max(dur, r.startH + r.doses * r.intervalH);
  dur = Math.max(dur, lastObs + 0.01);

  const run = (eta: Eta) => {
    const sim = simulate({ patient, physiology: phys, regimens, durationH: dur, etas: { [drugId]: eta } });
    return sim;
  };
  const objective = (x: number[]) => {
    const eta = { CL: x[0], V: x[1], ka: 0 };
    const sim = run(eta);
    const s = sim.series[drugId];
    let obj = (x[0] / wCL) ** 2 + (x[1] / wV) ** 2;
    for (const o of observations) {
      const pred = predictAt(sim.t, s.conc, o.timeH);
      const sd = Math.sqrt((prop * pred) ** 2 + add ** 2);
      obj += ((o.value - pred) / sd) ** 2 + 2 * Math.log(sd);
    }
    return obj;
  };
  const fit = nelderMead(objective, [0, 0], { maxIter: 160, step: 0.25, tol: 1e-5 });
  const eta = { CL: fit.x[0], V: fit.x[1], ka: 0 };
  const ind = run(eta);
  const pop = run({ CL: 0, V: 0, ka: 0 });
  const pi = ind.params[drugId];
  const pp = pop.params[drugId];

  // curvature along CL for an approximate credible interval
  const h = 0.05;
  const f0 = fit.fx;
  const fp = objective([eta.CL + h, eta.V]);
  const fm = objective([eta.CL - h, eta.V]);
  const curv = Math.max((fp - 2 * f0 + fm) / (h * h), 1e-6);
  const se = Math.sqrt(2 / curv);
  const clInterval: [number, number] = [pi.CL * Math.exp(-1.645 * se), pi.CL * Math.exp(1.645 * se)];

  return {
    eta,
    individual: { CL: pi.CL, V: pi.Vc + pi.Vp, halfLifeH: (0.693 * (pi.Vc + pi.Vp)) / pi.CL },
    population: { CL: pp.CL, V: pp.Vc + pp.Vp, halfLifeH: (0.693 * (pp.Vc + pp.Vp)) / pp.CL },
    objective: fit.fx,
    fitted: observations.map((o) => ({
      timeH: o.timeH,
      observed: o.value,
      predicted: predictAt(ind.t, ind.series[drugId].conc, o.timeH),
      populationPredicted: predictAt(pop.t, pop.series[drugId].conc, o.timeH),
    })),
    clInterval,
    shrinkageNote:
      observations.length < 2
        ? 'Single level: estimate is strongly informed by the population prior (high shrinkage).'
        : 'Multiple levels: individual parameters are well informed by the data.',
  };
}
