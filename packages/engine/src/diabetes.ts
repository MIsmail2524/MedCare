// Metabolic twin: Bergman minimal model of glucose–insulin dynamics (Bergman 1979; parameters for
// type 2 diabetes from the literature) with meal absorption and drug effects — metformin lowers
// endogenous glucose production, sulfonylureas raise insulin secretion, glucocorticoids reduce
// insulin sensitivity — giving 24-h glucose profiles, hypo/hyperglycaemia time and estimated HbA1c.

export interface MetabolicDrug {
  id: string;
  name: string;
  /** effect-site half-life (h) used to shape the daily effect profile */
  halfLifeH: number;
  doseTimes: number[]; // hours of the day
  effect: { egp?: number; secretion?: number; sensitivity?: number }; // fractional change at full effect
}

export const METABOLIC_DRUGS: MetabolicDrug[] = [
  { id: 'metformin', name: 'Metformin 1 g bid', halfLifeH: 6, doseTimes: [8, 20], effect: { egp: -0.3 } },
  { id: 'glipizide', name: 'Glipizide 10 mg daily (sulfonylurea)', halfLifeH: 4, doseTimes: [8], effect: { secretion: 1.2 } },
  { id: 'prednisone', name: 'Prednisone 40 mg mane (glucocorticoid)', halfLifeH: 3.5, doseTimes: [8], effect: { sensitivity: -0.5 } },
  { id: 'empagliflozin', name: 'Empagliflozin 10 mg (SGLT2i)', halfLifeH: 12, doseTimes: [8], effect: { egp: -0.12 } },
];

export interface MetabolicPatient {
  type: 'healthy' | 't2d' | 'prediabetes';
  weightKg: number;
}

export interface GlucoseDay {
  t: number[];
  glucose: number[]; // mg/dL
  insulin: number[]; // µU/mL
  meanGlucose: number;
  timeBelow70: number;
  timeAbove180: number;
  timeInRange: number;
  hba1c: number;
}

const MEALS: [number, number][] = [[7, 45], [12.5, 70], [19, 75]]; // hour, grams carbohydrate

export function glucoseDay(p: MetabolicPatient, drugs: MetabolicDrug[], days = 3): GlucoseDay {
  const prm = p.type === 't2d' ? { Gb: 150, Ib: 14, p1: 0.012, p2: 0.02, p3: 4e-6, n: 0.13, gamma: 0.0025, h: 110 } : p.type === 'prediabetes' ? { Gb: 108, Ib: 11, p1: 0.02, p2: 0.025, p3: 8e-6, n: 0.14, gamma: 0.004, h: 100 } : { Gb: 88, Ib: 8, p1: 0.03, p2: 0.03, p3: 1.3e-5, n: 0.15, gamma: 0.006, h: 90 };
  const Vg = 1.6 * p.weightKg; // dL
  const dt = 1 / 60; // h
  let G = prm.Gb, X = 0, I = prm.Ib, Ra = 0, gut = 0;
  const T: number[] = [], GL: number[] = [], IN: number[] = [];
  const level = (d: MetabolicDrug, t: number) => d.doseTimes.reduce((s, dt0) => {
    let v = 0;
    for (let day = -2; day <= days; day++) {
      const td = t - (day * 24 + dt0);
      if (td >= 0) v += Math.exp((-0.693 * td) / d.halfLifeH) * (1 - Math.exp(-2 * td));
    }
    return s + v;
  }, 0);
  const sat = (x: number) => x / (x + 0.5);
  let below = 0, above = 0, inr = 0, sum = 0, cnt = 0;
  for (let k = 0; k <= days * 24 * 60; k++) {
    const t = k * dt;
    const hod = t % 24;
    for (const [mt, g] of MEALS) if (Math.abs(hod - mt) < dt / 2) gut += (g * 1000) / Vg; // mg/dL equivalent
    const absorb = 1.2 * gut; // h⁻¹
    gut -= absorb * dt;
    Ra = absorb;
    let egp = 1, sec = 1, sens = 1;
    for (const d of drugs) {
      const e = sat(level(d, t));
      if (d.effect.egp) egp *= 1 + d.effect.egp * e;
      if (d.effect.secretion) sec *= 1 + d.effect.secretion * e;
      if (d.effect.sensitivity) sens *= 1 + d.effect.sensitivity * e;
    }
    const pm = 60; // per-minute constants → per hour
    const dG = (-(prm.p1 * pm) * (G - prm.Gb) - X * G + (egp - 1) * prm.p1 * pm * prm.Gb + Ra) * 1;
    const dX = -prm.p2 * pm * X + prm.p3 * pm * pm * sens * (I - prm.Ib);
    // first-phase-free secretion proportional to glucose above threshold, plus sulfonylurea basal drive
    const dI = -prm.n * pm * (I - prm.Ib) + sec * prm.gamma * pm * 10 * Math.max(G - prm.h, 0) + (sec - 1) * prm.n * pm * prm.Ib * 0.6;
    G = Math.max(30, G + dt * dG);
    X = Math.max(-0.05, X + dt * dX);
    I = Math.max(1, I + dt * dI);
    if (t >= (days - 1) * 24) {
      sum += G;
      cnt++;
      if (G < 70) below++;
      else if (G > 180) above++;
      else inr++;
    }
    if (k % 10 === 0 && t >= (days - 1) * 24) {
      T.push(t - (days - 1) * 24);
      GL.push(G);
      IN.push(I);
    }
  }
  const mean = sum / Math.max(cnt, 1);
  return { t: T, glucose: GL, insulin: IN, meanGlucose: mean, timeBelow70: below / cnt, timeAbove180: above / cnt, timeInRange: inr / cnt, hba1c: (mean + 46.7) / 28.7 };
}
