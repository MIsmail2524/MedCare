import { rng } from './population.js';

// Oncology twin: chemotherapy exposure → tumour response (Simeoni 2004 growth/kill model) and
// myelosuppression (Friberg 2002 semi-mechanistic neutropenia model), evaluated over a virtual
// population to compare schedules by efficacy *and* probability of grade-4 neutropenia.

export interface ChemoAgent {
  id: string;
  name: string;
  /** 1-compartment effective PK per m² BSA */
  clPerM2: number; // L/h/m²
  vPerM2: number; // L/m²
  mw: number;
  /** Friberg parameters: mean transit time (h), feedback γ, linear drug effect slope (per µmol/L) */
  mtt: number;
  gamma: number;
  slope: number;
  /** Simeoni potency k2 (per µmol/L per h) for a responsive tumour */
  k2: number;
  standard: { dose: number; intervalH: number; cycles: number; infusionH: number };
  source: string;
}

export const CHEMO: ChemoAgent[] = [
  { id: 'docetaxel', name: 'Docetaxel', clPerM2: 21, vPerM2: 333, mw: 807.9, mtt: 84.3, gamma: 0.161, slope: 40, k2: 0.13, standard: { dose: 75, intervalH: 504, cycles: 4, infusionH: 1 }, source: 'Friberg et al. J Clin Oncol 2002 (MTT, γ); slope and V calibrated in this 1-compartment form to grade 3–4 neutropenia ≈ 75 %, nadir day 7–8 and response ≈ 35–45 % at 75 mg/m² q3w' },
  { id: 'paclitaxel', name: 'Paclitaxel', clPerM2: 14, vPerM2: 300, mw: 853.9, mtt: 127, gamma: 0.239, slope: 18, k2: 0.04, standard: { dose: 175, intervalH: 504, cycles: 4, infusionH: 3 }, source: 'Friberg et al. 2002 (MTT, γ); slope calibrated to grade 3–4 neutropenia ≈ 60 % at 175 mg/m² q3w' },
  { id: 'doxorubicin', name: 'Doxorubicin', clPerM2: 28, vPerM2: 800, mw: 543.5, mtt: 110, gamma: 0.2, slope: 45, k2: 0.12, standard: { dose: 60, intervalH: 504, cycles: 4, infusionH: 0.25 }, source: 'Friberg-type model; parameters calibrated to grade 3–4 neutropenia ≈ 75 % at 60 mg/m² q3w (AC-regimen trials)' },
];

export interface ScheduleSpec {
  dose: number; // mg/m²
  intervalH: number;
  cycles: number;
  infusionH: number;
}

export interface OncoSubject {
  t: number[];
  conc: number[]; // µmol/L
  anc: number[]; // 10⁹/L
  tumour: number[]; // relative volume
  nadir: number;
  nadirDay: number;
  finalTumour: number;
}

/** Simulate one patient (BSA, baseline ANC, IIV multipliers). */
export function simulateOncology(agent: ChemoAgent, s: ScheduleSpec, bsa = 1.8, opts: { circ0?: number; clMult?: number; slopeMult?: number; k2Mult?: number; days?: number } = {}): OncoSubject {
  const days = opts.days ?? Math.ceil((s.cycles * s.intervalH) / 24 + 21);
  const dt = 0.25;
  const CL = agent.clPerM2 * bsa * (opts.clMult ?? 1);
  const V = agent.vPerM2 * bsa;
  const ktr = 4 / agent.mtt;
  const circ0 = opts.circ0 ?? 5;
  const slope = agent.slope * (opts.slopeMult ?? 1);
  const k2 = agent.k2 * (opts.k2Mult ?? 1);
  let A = 0;
  let prol = circ0, t1 = circ0, t2 = circ0, t3 = circ0, circ = circ0;
  // Simeoni: x1 proliferating, x2..x4 damaged; λ0 exponential, λ1 linear growth
  const l0 = 0.0008, l1 = 0.004, psi = 20, k1 = 0.02; // tumour doubling ≈ 5–6 weeks
  let x1 = 1, x2 = 0, x3 = 0, x4 = 0;
  const T: number[] = [], Cc: number[] = [], ANC: number[] = [], TU: number[] = [];
  let nadir = circ0, nadirT = 0;
  for (let k = 0; k <= (days * 24) / dt; k++) {
    const t = k * dt;
    let rate = 0;
    for (let c = 0; c < s.cycles; c++) {
      const st = c * s.intervalH;
      if (t >= st && t < st + s.infusionH) rate = (s.dose * bsa) / s.infusionH;
    }
    const Cmg = A / V;
    const C = (Cmg / agent.mw) * 1000; // µmol/L
    const edrug = Math.min(slope * C, 0.99);
    const fb = (circ0 / Math.max(circ, 1e-3)) ** agent.gamma;
    const dProl = ktr * prol * (1 - edrug) * fb - ktr * prol;
    const d1 = ktr * (prol - t1);
    const d2 = ktr * (t1 - t2);
    const d3 = ktr * (t2 - t3);
    const dC = ktr * t3 - ktr * circ;
    A += dt * (rate - (CL / V) * A);
    prol += dt * dProl;
    t1 += dt * d1;
    t2 += dt * d2;
    t3 += dt * d3;
    circ += dt * dC;
    const w = x1 + x2 + x3 + x4;
    const growth = (l0 * x1) / (1 + ((l0 / l1) * w) ** psi) ** (1 / psi);
    const dx1 = growth - k2 * C * x1;
    const dx2 = k2 * C * x1 - k1 * x2;
    const dx3 = k1 * (x2 - x3);
    const dx4 = k1 * (x3 - x4);
    x1 = Math.max(x1 + dt * dx1, 0);
    x2 += dt * dx2;
    x3 += dt * dx3;
    x4 = Math.max(x4 + dt * dx4 - dt * k1 * x4, 0);
    if (circ < nadir) {
      nadir = circ;
      nadirT = t;
    }
    if (k % 8 === 0) {
      T.push(t / 24);
      Cc.push(C);
      ANC.push(circ);
      TU.push(x1 + x2 + x3 + x4);
    }
  }
  return { t: T, conc: Cc, anc: ANC, tumour: TU, nadir, nadirDay: nadirT / 24, finalTumour: TU[TU.length - 1] };
}

export interface OncoTrial {
  pGrade4: number;
  pGrade3plus: number;
  medianNadir: number;
  medianNadirDay: number;
  pResponse: number;
  medianTumour: number;
  example: OncoSubject;
}

/** Virtual population: IIV on clearance (CV 35%), baseline ANC, drug sensitivity and tumour potency. */
export function oncologyTrial(agent: ChemoAgent, s: ScheduleSpec, n = 150, seed = 3): OncoTrial {
  const r = rng(seed);
  const ln = (cv: number) => Math.exp(Math.sqrt(Math.log(1 + cv * cv)) * r.normal());
  const subs: OncoSubject[] = [];
  for (let i = 0; i < n; i++) {
    const bsa = Math.min(2.4, Math.max(1.3, 1.85 + 0.18 * r.normal()));
    subs.push(simulateOncology(agent, s, bsa, { clMult: ln(0.35), circ0: 5 * ln(0.3), slopeMult: ln(0.4), k2Mult: ln(0.6) }));
  }
  const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  return {
    pGrade4: subs.filter((x) => x.nadir < 0.5).length / n,
    pGrade3plus: subs.filter((x) => x.nadir < 1).length / n,
    medianNadir: med(subs.map((x) => x.nadir)),
    medianNadirDay: med(subs.map((x) => x.nadirDay % (s.intervalH / 24))),
    pResponse: subs.filter((x) => x.finalTumour < 0.7).length / n, // ≥ 30 % shrinkage (RECIST-like, volume proxy)
    medianTumour: med(subs.map((x) => x.finalTumour)),
    example: subs[0],
  };
}
