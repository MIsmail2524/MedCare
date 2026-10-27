import { leanBodyWeight } from './physiology.js';

// Three-compartment intravenous anaesthetic models with an effect-site compartment.
// Time unit in this module: minutes. Propofol mg & µg/mL, remifentanil µg & ng/mL.

export type AnaestheticModel = 'marsh' | 'schnider' | 'minto';

export interface ThreeCompParams {
  model: AnaestheticModel;
  drug: 'propofol' | 'remifentanil';
  V1: number; // L
  k10: number;
  k12: number;
  k13: number;
  k21: number;
  k31: number;
  ke0: number; // 1/min
}

export interface AnaesthesiaPatient {
  age: number;
  weightKg: number;
  heightCm: number;
  sex: 'male' | 'female';
}

/** Marsh (1991) propofol model, ke0 = 0.26 min⁻¹ (original). */
export function marsh(p: AnaesthesiaPatient): ThreeCompParams {
  return { model: 'marsh', drug: 'propofol', V1: 0.228 * p.weightKg, k10: 0.119, k12: 0.112, k13: 0.0419, k21: 0.055, k31: 0.0033, ke0: 0.26 };
}

/** Schnider (1998/1999) propofol model. */
export function schnider(p: AnaesthesiaPatient): ThreeCompParams {
  const lbm = leanBodyWeightJames(p);
  const V1 = 4.27;
  const V2 = 18.9 - 0.391 * (p.age - 53);
  const V3 = 238;
  const Cl1 = 1.89 + 0.0456 * (p.weightKg - 77) - 0.0681 * (lbm - 59) + 0.0264 * (p.heightCm - 177);
  const Cl2 = 1.29 - 0.024 * (p.age - 53);
  const Cl3 = 0.836;
  return { model: 'schnider', drug: 'propofol', V1, k10: Cl1 / V1, k12: Cl2 / V1, k13: Cl3 / V1, k21: Cl2 / V2, k31: Cl3 / V3, ke0: 0.456 };
}

/** Minto (1997) remifentanil model. */
export function minto(p: AnaesthesiaPatient): ThreeCompParams {
  const lbm = leanBodyWeightJames(p);
  const V1 = 5.1 - 0.0201 * (p.age - 40) + 0.072 * (lbm - 55);
  const V2 = 9.82 - 0.0811 * (p.age - 40) + 0.108 * (lbm - 55);
  const V3 = 5.42;
  const Cl1 = 2.6 - 0.0162 * (p.age - 40) + 0.0191 * (lbm - 55);
  const Cl2 = 2.05 - 0.0301 * (p.age - 40);
  const Cl3 = 0.076 - 0.00113 * (p.age - 40);
  return { model: 'minto', drug: 'remifentanil', V1, k10: Cl1 / V1, k12: Cl2 / V1, k13: Cl3 / V1, k21: Cl2 / V2, k31: Cl3 / V3, ke0: 0.595 - 0.007 * (p.age - 40) };
}

/** James formula used by Schnider and Minto (note: degenerates in severe obesity). */
export function leanBodyWeightJames(p: AnaesthesiaPatient): number {
  const r = p.weightKg / p.heightCm;
  const james = p.sex === 'male' ? 1.1 * p.weightKg - 128 * r * r : 1.07 * p.weightKg - 148 * r * r;
  // Fall back to Janmahasatian where James becomes paradoxical (BMI > ~42 in men, ~37 in women).
  const jan = leanBodyWeight(p.sex, p.weightKg, p.heightCm);
  return james > 0.3 * p.weightKg && james < p.weightKg ? james : jan;
}

export interface CompState {
  a1: number;
  a2: number;
  a3: number;
  ce: number;
}

function stepState(s: CompState, k: ThreeCompParams, rate: number, dt: number): CompState {
  // RK4 on amounts (mg or µg) per minute; rate is amount/min
  const f = (x: CompState): CompState => {
    const c1 = x.a1 / k.V1;
    return {
      a1: rate - (k.k10 + k.k12 + k.k13) * x.a1 + k.k21 * x.a2 + k.k31 * x.a3,
      a2: k.k12 * x.a1 - k.k21 * x.a2,
      a3: k.k13 * x.a1 - k.k31 * x.a3,
      ce: k.ke0 * (c1 - x.ce),
    };
  };
  const add = (a: CompState, b: CompState, h: number): CompState => ({ a1: a.a1 + h * b.a1, a2: a.a2 + h * b.a2, a3: a.a3 + h * b.a3, ce: a.ce + h * b.ce });
  const k1 = f(s);
  const k2 = f(add(s, k1, dt / 2));
  const k3 = f(add(s, k2, dt / 2));
  const k4 = f(add(s, k3, dt));
  return {
    a1: s.a1 + (dt / 6) * (k1.a1 + 2 * k2.a1 + 2 * k3.a1 + k4.a1),
    a2: s.a2 + (dt / 6) * (k1.a2 + 2 * k2.a2 + 2 * k3.a2 + k4.a2),
    a3: s.a3 + (dt / 6) * (k1.a3 + 2 * k2.a3 + 2 * k3.a3 + k4.a3),
    ce: s.ce + (dt / 6) * (k1.ce + 2 * k2.ce + 2 * k3.ce + k4.ce),
  };
}

export interface TciStepResult {
  state: CompState;
  rate: number; // amount/min delivered during the step
  cp: number;
  ce: number;
}

/**
 * One control step of target-controlled infusion. Effect-site targeting chooses the largest rate
 * (≤ maxRate) for this step such that the predicted effect-site peak does not overshoot the target.
 */
export function tciStep(state: CompState, k: ThreeCompParams, target: number, mode: 'plasma' | 'effect', maxRate: number, dt: number): TciStepResult {
  const sub = 10;
  const h = dt / sub;
  const simulateStep = (r: number) => {
    let s = state;
    for (let i = 0; i < sub; i++) s = stepState(s, k, r, h);
    return s;
  };
  const peakCe = (s0: CompState) => {
    let s = s0;
    let peak = s.ce;
    for (let i = 0; i < 120; i++) {
      s = stepState(s, k, 0, 0.1);
      if (s.ce > peak) peak = s.ce;
      else if (s.ce < peak * 0.999 && i > 5) break;
    }
    return peak;
  };
  let rate = 0;
  if (mode === 'plasma') {
    const free = simulateStep(0).a1 / k.V1;
    const unit = simulateStep(1).a1 / k.V1 - free;
    rate = Math.min(Math.max((target - free) / Math.max(unit, 1e-12), 0), maxRate);
  } else {
    const ok = (r: number) => peakCe(simulateStep(r)) <= target * 1.0;
    if (ok(maxRate)) rate = maxRate;
    else if (!ok(0)) rate = 0;
    else {
      let lo = 0;
      let hi = maxRate;
      for (let i = 0; i < 18; i++) {
        const m = (lo + hi) / 2;
        if (ok(m)) lo = m;
        else hi = m;
      }
      rate = lo;
    }
  }
  const next = simulateStep(rate);
  return { state: next, rate, cp: next.a1 / k.V1, ce: next.ce };
}

export function advance(state: CompState, k: ThreeCompParams, rate: number, dt: number): CompState {
  const sub = 10;
  let s = state;
  for (let i = 0; i < sub; i++) s = stepState(s, k, rate, dt / sub);
  return s;
}

// --- Pharmacodynamics -------------------------------------------------------

/** Propofol–remifentanil hypnotic interaction (Bouillon 2004, BIS). Ce in µg/mL & ng/mL. */
export function predictBIS(cePropofol: number, ceRemi: number, sensitivity = 1): number {
  const C50P = 4.47 / sensitivity;
  const C50R = 19.3 / sensitivity;
  const gamma = 1.43;
  const u = cePropofol / C50P + ceRemi / C50R;
  const e = u ** gamma / (1 + u ** gamma);
  return 97.4 - 97.4 * e;
}

/** Probability of tolerance to laryngoscopy (Bouillon 2004 response surface, approximate Greco). */
export function probNoResponseLaryngoscopy(cePropofol: number, ceRemi: number): number {
  const C50P = 5.6;
  const C50R = 1.2;
  const alpha = 3.4;
  const up = cePropofol / C50P;
  const ur = ceRemi / C50R;
  const u = up + ur + alpha * up * ur;
  return u ** 4 / (1 + u ** 4);
}

/** Mean arterial pressure response. */
export function predictMAP(baselineMAP: number, cePropofol: number, ceRemi: number, stimulus: number, bloodLossFrac: number): number {
  const prop = (0.4 * cePropofol) / (cePropofol + 3.5);
  const remi = (0.2 * ceRemi) / (ceRemi + 4);
  const hypovolaemia = Math.min(bloodLossFrac * 1.2, 0.6);
  const stimUp = stimulus * 0.25 * (1 - probNoResponseLaryngoscopy(cePropofol, ceRemi));
  return baselineMAP * (1 - prop - remi - hypovolaemia + stimUp);
}

export function predictHR(baselineHR: number, ceRemi: number, stimulus: number, bloodLossFrac: number, cePropofol: number): number {
  const brady = (0.25 * ceRemi) / (ceRemi + 5);
  const reflex = Math.min(bloodLossFrac * 1.5, 0.6);
  const stimUp = stimulus * 0.2 * (1 - probNoResponseLaryngoscopy(cePropofol, ceRemi));
  return baselineHR * (1 - brady + reflex + stimUp);
}

/** Respiratory drive (fraction of baseline minute ventilation) for a spontaneously breathing patient. */
export function respiratoryDrive(cePropofol: number, ceRemi: number): number {
  const u = cePropofol / 3 + ceRemi / 2;
  return 1 / (1 + u ** 2.5);
}

// --- Training scenarios -----------------------------------------------------

export interface SurgicalEvent {
  minute: number;
  label: string;
  stimulus: number; // 0..1 noxious stimulation intensity
  bloodLossMl?: number;
  description: string;
}

export interface SurgicalScenario {
  id: string;
  title: string;
  summary: string;
  patient: AnaesthesiaPatient & { asa: 1 | 2 | 3 | 4; baselineMAP: number; baselineHR: number; sensitivity: number; history: string };
  durationMin: number;
  events: SurgicalEvent[];
  objectives: string[];
}

export const SURGICAL_SCENARIOS: SurgicalScenario[] = [
  {
    id: 'lap-chole',
    title: 'Laparoscopic cholecystectomy',
    summary: 'Healthy adult, total intravenous anaesthesia with propofol/remifentanil TCI.',
    patient: { age: 45, weightKg: 78, heightCm: 172, sex: 'female', asa: 1, baselineMAP: 90, baselineHR: 74, sensitivity: 1, history: 'Symptomatic gallstones; no comorbidities.' },
    durationMin: 75,
    events: [
      { minute: 0, label: 'Induction', stimulus: 0, description: 'Start TCI and pre-oxygenate.' },
      { minute: 5, label: 'Laryngoscopy & intubation', stimulus: 1, description: 'Intense stimulus — ensure adequate opioid effect-site concentration.' },
      { minute: 15, label: 'Skin incision & insufflation', stimulus: 0.8, description: 'Pneumoperitoneum 12 mmHg raises MAP.' },
      { minute: 30, label: 'Gallbladder dissection', stimulus: 0.6, bloodLossMl: 100, description: 'Steady surgical stimulation.' },
      { minute: 60, label: 'Port-site closure', stimulus: 0.3, description: 'Begin reducing targets for emergence.' },
      { minute: 70, label: 'Emergence', stimulus: 0.1, description: 'Stop infusions; aim for BIS > 70 before extubation.' },
    ],
    objectives: ['BIS 40–60 during surgery', 'MAP ≥ 65 mmHg throughout', 'No response to intubation (P(no response) ≥ 0.9)', 'Awake within 10 min of stopping'],
  },
  {
    id: 'elderly-hip',
    title: 'Elderly hip fracture fixation',
    summary: '84-year-old frail patient: reduced dose requirements and haemodynamic fragility.',
    patient: { age: 84, weightKg: 58, heightCm: 160, sex: 'female', asa: 3, baselineMAP: 95, baselineHR: 80, sensitivity: 1.5, history: 'Hypertension, CKD stage 3, mild cognitive impairment.' },
    durationMin: 90,
    events: [
      { minute: 0, label: 'Induction', stimulus: 0, description: 'Titrate slowly — frail patient.' },
      { minute: 6, label: 'Laryngeal mask insertion', stimulus: 0.6, description: 'Moderate stimulus.' },
      { minute: 20, label: 'Incision', stimulus: 0.7, description: 'Surgical stimulation begins.' },
      { minute: 40, label: 'Reduction & reaming', stimulus: 0.9, bloodLossMl: 450, description: 'Significant blood loss — watch MAP.' },
      { minute: 75, label: 'Closure', stimulus: 0.3, description: 'Prepare for emergence.' },
      { minute: 85, label: 'Emergence', stimulus: 0.1, description: 'Avoid excess sedation (post-op delirium).' },
    ],
    objectives: ['Avoid MAP < 65 mmHg (cumulative < 5 min)', 'BIS 45–60; avoid BIS < 40 (delirium risk)', 'Prompt emergence'],
  },
  {
    id: 'trauma-laparotomy',
    title: 'Trauma laparotomy with haemorrhage',
    summary: 'Young trauma patient with ongoing bleeding: balance hypnosis and haemodynamic stability.',
    patient: { age: 28, weightKg: 85, heightCm: 183, sex: 'male', asa: 4, baselineMAP: 75, baselineHR: 112, sensitivity: 1.3, history: 'Motorcycle collision; splenic laceration; FAST positive.' },
    durationMin: 60,
    events: [
      { minute: 0, label: 'Rapid-sequence induction', stimulus: 0, description: 'Reduced doses in hypovolaemia.' },
      { minute: 2, label: 'Intubation', stimulus: 1, description: 'Intense stimulus.' },
      { minute: 8, label: 'Laparotomy', stimulus: 0.9, bloodLossMl: 800, description: 'Massive haemorrhage on opening.' },
      { minute: 20, label: 'Splenectomy', stimulus: 0.7, bloodLossMl: 500, description: 'Bleeding controlled after splenic hilum clamp.' },
      { minute: 45, label: 'Abdominal packing / closure', stimulus: 0.4, description: 'Damage-control closure.' },
    ],
    objectives: ['MAP ≥ 60 mmHg (permissive hypotension)', 'BIS < 60 (avoid awareness)', 'Minimise time with BIS < 35'],
  },
];

export interface ORSnapshot {
  minute: number;
  cpProp: number;
  ceProp: number;
  cpRemi: number;
  ceRemi: number;
  rateProp: number; // mg/h
  rateRemi: number; // µg/min
  bis: number;
  map: number;
  hr: number;
  pNoResponse: number;
  stimulus: number;
  bloodLossMl: number;
  event?: string;
}

export interface ORScore {
  pctBisInRange: number;
  minutesHypotension: number;
  minutesBisDeep: number;
  minutesBisLight: number;
  intubationResponseProb: number | null;
  propofolTotalMg: number;
  remiTotalUg: number;
  score: number;
  feedback: string[];
}

export function scoreOR(snaps: ORSnapshot[], scenario: SurgicalScenario): ORScore {
  if (!snaps.length) return { pctBisInRange: 0, minutesHypotension: 0, minutesBisDeep: 0, minutesBisLight: 0, intubationResponseProb: null, propofolTotalMg: 0, remiTotalUg: 0, score: 0, feedback: [] };
  const dt = snaps.length > 1 ? snaps[1].minute - snaps[0].minute : 1 / 6;
  const surgical = snaps.filter((s) => s.minute >= 8 && s.minute <= scenario.durationMin - 10);
  const inRange = surgical.filter((s) => s.bis >= 40 && s.bis <= 60).length;
  const hypo = snaps.filter((s) => s.map < (scenario.id === 'trauma-laparotomy' ? 60 : 65)).length * dt;
  const deep = snaps.filter((s) => s.bis < 40).length * dt;
  const light = surgical.filter((s) => s.bis > 65).length * dt;
  const intubation = scenario.events.find((e) => e.stimulus >= 0.6 && e.minute < 10);
  const atIntub = intubation ? snaps.find((s) => s.minute >= intubation.minute) : undefined;
  const propTotal = snaps.reduce((s, x) => s + (x.rateProp / 60) * dt, 0);
  const remiTotal = snaps.reduce((s, x) => s + x.rateRemi * dt, 0);
  const pct = surgical.length ? (100 * inRange) / surgical.length : 0;
  const feedback: string[] = [];
  let score = 100;
  score -= Math.max(0, 80 - pct) * 0.6;
  score -= Math.min(30, hypo * 3);
  score -= Math.min(20, deep * 1);
  score -= Math.min(25, light * 2.5);
  if (atIntub && atIntub.pNoResponse < 0.9) {
    score -= 10;
    feedback.push(`Response to ${intubation!.label.toLowerCase()} likely (P(no response) ${(atIntub.pNoResponse * 100).toFixed(0)}%). Increase remifentanil Ce before the stimulus.`);
  }
  if (hypo > 5) feedback.push(`Hypotension for ${hypo.toFixed(1)} min — reduce propofol target or treat with vasopressor/fluids.`);
  if (deep > 5) feedback.push(`BIS < 40 for ${deep.toFixed(1)} min — excessive depth increases post-operative delirium risk.`);
  if (light > 2) feedback.push(`BIS > 65 during surgery for ${light.toFixed(1)} min — awareness risk.`);
  if (pct >= 80) feedback.push('Excellent hypnotic control during the surgical phase.');
  return {
    pctBisInRange: pct,
    minutesHypotension: hypo,
    minutesBisDeep: deep,
    minutesBisLight: light,
    intubationResponseProb: atIntub ? 1 - atIntub.pNoResponse : null,
    propofolTotalMg: propTotal,
    remiTotalUg: remiTotal,
    score: Math.max(0, Math.round(score)),
    feedback,
  };
}
