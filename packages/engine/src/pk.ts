import { getDrug } from './drugs.js';
import { derivePhysiology, VKORC1_EC50_FACTOR } from './physiology.js';
import type {
  Drug,
  ExposureBasis,
  IndividualParams,
  Organ,
  Pathway,
  Patient,
  Physiology,
  Regimen,
  Strength,
} from './types.js';

export const ORGANS: Organ[] = ['brain', 'thyroid', 'heart', 'lungs', 'liver', 'pancreas', 'gi', 'kidneys', 'blood', 'muscle', 'skin'];
const PATHWAYS: Pathway[] = ['CYP3A4', 'CYP3A5', 'CYP2D6', 'CYP2C9', 'CYP2C19', 'CYP1A2', 'CYP2B6', 'CYP2E1', 'UGT', 'Pgp'];

/** Residual pathway activity at the perpetrator's typical steady-state concentration. */
export const INHIBITION_RESIDUAL: Record<Strength, number> = { strong: 0.1, moderate: 0.35, weak: 0.7 };
/** Fold-increase of pathway activity at the inducer's typical steady-state concentration. */
export const INDUCTION_FOLD: Record<Strength, number> = { strong: 5, moderate: 2.5, weak: 1.5 };
/** Enzyme degradation rate constant (h⁻¹), ≈ 36 h half-life for hepatic CYPs. */
export const ENZYME_KDEG = 0.019;

/** Curated pairwise effects not captured by CYP mechanisms (renal transporter / haemodynamic). */
export const RENAL_INTERACTIONS: { victim: string; perpetrator: string; factor: number; note: string }[] = [
  { victim: 'lithium', perpetrator: 'ibuprofen', factor: 0.7, note: 'NSAIDs reduce renal prostaglandins and lithium clearance (~25–40%).' },
  { victim: 'lithium', perpetrator: 'lisinopril', factor: 0.65, note: 'ACE inhibitors increase proximal lithium reabsorption.' },
  { victim: 'lithium', perpetrator: 'furosemide', factor: 0.85, note: 'Volume depletion increases lithium reabsorption.' },
  { victim: 'methotrexate', perpetrator: 'ibuprofen', factor: 0.7, note: 'NSAIDs compete for OAT-mediated tubular secretion of methotrexate.' },
  { victim: 'methotrexate', perpetrator: 'omeprazole', factor: 0.8, note: 'PPIs inhibit BCRP/H⁺-dependent methotrexate secretion.' },
  { victim: 'digoxin', perpetrator: 'clarithromycin', factor: 0.85, note: 'Additional P-gp inhibition in renal tubule.' },
];

export interface DrugState {
  gut: number;
  central: number;
  periph: number;
  ce: number;
}
export interface SimState {
  drugs: Record<string, DrugState>;
  enzymes: Record<Pathway, number>;
}

export interface Eta {
  CL: number;
  V: number;
  ka: number;
}

export interface SimulationInput {
  patient: Patient;
  regimens: Regimen[];
  durationH?: number;
  at?: Date;
  physiology?: Physiology;
  etas?: Record<string, Eta>;
  initial?: SimState;
  /** Skip downsampled outputs and organ series (faster; used for population/optimisation). */
  metricsOnly?: boolean;
  /** Override integration step. */
  dt?: number;
}

export interface DrugMetrics {
  drugId: string;
  unit: string;
  cmax: number;
  tmax: number;
  cmin: number;
  troughLast: number;
  peakLast: number;
  avgLast: number;
  auc24: number;
  aucTotal: number;
  final: number;
  halfLifeH: number;
  clearanceLh: number;
  volumeL: number;
  timeInRangePct: number | null;
  timeToxicPct: number | null;
  targetValue: number | null;
  targetStatus: 'below' | 'within' | 'above' | 'n/a';
  toxicStatus: 'ok' | 'toxic' | 'n/a';
  doseMg: number;
  intervalH: number;
}

export interface DrugSeries {
  conc: number[];
  active?: number[];
  effect?: number[];
}

export interface SimulationResult {
  t: number[];
  durationH: number;
  series: Record<string, DrugSeries>;
  qtc: number[];
  organs: Record<Organ, { therapeutic: number[]; risk: number[] }>;
  enzymes: Record<Pathway, number[]>;
  metrics: Record<string, DrugMetrics>;
  params: Record<string, IndividualParams>;
  physiology: Physiology;
  finalState: SimState;
  drugIds: string[];
}

// ---------------------------------------------------------------------------

function sizeWeight(drug: Drug, phys: Physiology, patient: Patient): number {
  switch (drug.pk.vScale) {
    case 'IBW':
      return Math.min(phys.ibw, patient.weightKg);
    case 'ABW':
      return patient.weightKg > 1.2 * phys.ibw ? phys.abw : patient.weightKg;
    case 'LBW':
      return phys.lbw;
    default:
      return patient.weightKg;
  }
}

export function doseInMg(drug: Drug, dose: number, unit: Regimen['unit'], patient: Patient, phys: Physiology): number {
  if (unit === 'mg/kg') return dose * sizeWeight(drug, phys, patient);
  if (unit === 'mg/m2') return dose * phys.bsa;
  return dose;
}

function bioavailability(drug: Drug, route: Regimen['route'], phys: Physiology): number {
  if (route === 'po') return drug.pk.F * phys.absorptionFactor;
  if (route === 'sc') return drug.defaultRegimen.route === 'sc' ? drug.pk.F : 0.95;
  return 1;
}

/** Individual PK parameters for a patient (before dynamic drug–drug interaction modulation). */
export function individualize(drug: Drug, patient: Patient, phys: Physiology, eta: Eta = { CL: 0, V: 0, ka: 0 }): IndividualParams {
  const pk = drug.pk;
  const w = sizeWeight(drug, phys, patient);
  const size = (w / 70) ** 0.75;
  const eCL = Math.exp(eta.CL);
  const Vc = pk.Vc * w * phys.volumeFactor * Math.exp(eta.V);
  const Vp = (pk.Vp ?? 0) * w * phys.volumeFactor * Math.exp(eta.V);
  const Q = (pk.Q ?? 0) * size;

  const renal = pk.CL * pk.fe * phys.renalFactor * eCL;
  const nonRenal = pk.CL * (1 - pk.fe) * phys.hepaticFactor * size * eCL;
  let fmSum = 0;
  const pathways: { pathway: Pathway; f: number }[] = [];
  for (const m of drug.metabolism) {
    const act = phys.enzymeActivity[m.pathway];
    pathways.push({ pathway: m.pathway, f: nonRenal * m.fm * act });
    if (m.pathway !== 'CYP3A5') fmSum += m.fm;
  }
  const other = nonRenal * Math.max(0, 1 - fmSum);
  const CL = renal + other + pathways.reduce((s, p) => s + p.f, 0);

  let vmax: number | undefined;
  let km: number | undefined;
  if (pk.mm) {
    // Michaelis–Menten capacity scales with hepatic function and genetics of the metabolic pathways.
    const genetic = drug.metabolism.reduce((s, m) => s + m.fm * phys.enzymeActivity[m.pathway], 0) + Math.max(0, 1 - fmSum);
    vmax = ((pk.mm.Vmax * patient.weightKg) / 24) * phys.hepaticFactor * genetic * eCL;
    km = pk.mm.Km;
  }
  return {
    CL,
    Vc,
    Vp,
    Q,
    ka: pk.ka * Math.exp(eta.ka),
    F: pk.F,
    tlag: pk.tlag ?? 0,
    vmax,
    km,
    shares: { renal, renalPgp: pk.renalPgpShare ?? 0, pathways, other },
  };
}

const refCache = new Map<string, number>();
/** Typical steady-state average concentration (mg/L) of the default regimen in the reference adult. */
export function referenceConcentration(drug: Drug): number {
  const hit = refCache.get(drug.id);
  if (hit !== undefined) return hit;
  const r = drug.defaultRegimen;
  const dose = r.unit === 'mg/kg' ? r.dose * 70 : r.unit === 'mg/m2' ? r.dose * 1.85 : r.dose;
  const F = r.route === 'po' ? drug.pk.F : r.route === 'sc' ? drug.pk.F : 1;
  const rate = (F * dose) / r.intervalH;
  let c: number;
  if (drug.pk.mm) {
    const vmax = (drug.pk.mm.Vmax * 70) / 24;
    c = rate < vmax ? (drug.pk.mm.Km * rate) / (vmax - rate) : drug.pk.mm.Km * 10;
  } else c = rate / drug.pk.CL;
  refCache.set(drug.id, c);
  return c;
}

export function exposureToConc(drug: Drug, value: number, basis: ExposureBasis): number {
  const v = basis === 'auc24' ? value / 24 : value;
  return v / drug.display.factor;
}

interface DoseEvent {
  t: number;
  drug: number;
  amount: number;
  target: 'gut' | 'central';
}
interface Infusion {
  start: number;
  end: number;
  drug: number;
  rate: number;
}

interface Perp {
  /** index of perpetrator drug */
  j: number;
  ki: number;
}

/** Simulate concentrations, effects, QTc and organ load for a multi-drug regimen. */
export function simulate(input: SimulationInput): SimulationResult {
  const { patient } = input;
  const phys = input.physiology ?? derivePhysiology(patient, input.at);
  const regimens = input.regimens.filter((r) => r.doses > 0 && r.dose > 0);

  // ---- drug set
  const ids: string[] = [];
  for (const r of regimens) if (!ids.includes(r.drugId)) ids.push(r.drugId);
  if (input.initial) {
    for (const [id, s] of Object.entries(input.initial.drugs)) {
      if (!ids.includes(id) && s.central + s.gut + s.periph > 1e-6) ids.push(id);
    }
  }
  const drugs = ids.map(getDrug);
  const n = drugs.length;
  const params = drugs.map((d) => individualize(d, patient, phys, input.etas?.[d.id]));
  const refs = drugs.map(referenceConcentration);

  // ---- duration
  let durationH = input.durationH ?? 0;
  if (!input.durationH) {
    for (const r of regimens) durationH = Math.max(durationH, r.startH + r.doses * r.intervalH);
    if (durationH === 0) durationH = 72;
  }
  durationH = Math.min(durationH, 24 * 365);

  // ---- dosing events
  const events: DoseEvent[] = [];
  const infusions: Infusion[] = [];
  const doseMg: number[] = new Array(n).fill(0);
  const intervals: number[] = new Array(n).fill(24);
  const lastDoseT: number[] = new Array(n).fill(-1);
  for (const r of regimens) {
    const i = ids.indexOf(r.drugId);
    const d = drugs[i];
    const mg = doseInMg(d, r.dose, r.unit, patient, phys);
    const loading = r.loadingDose ? doseInMg(d, r.loadingDose, r.unit, patient, phys) : mg;
    doseMg[i] = mg;
    intervals[i] = r.intervalH;
    const F = bioavailability(d, r.route, phys);
    for (let k = 0; k < r.doses; k++) {
      const t = r.startH + k * r.intervalH;
      if (t >= durationH) break;
      lastDoseT[i] = Math.max(lastDoseT[i], t);
      const amt = k === 0 ? loading : mg;
      if (r.route === 'iv_infusion') {
        const dur = Math.max(r.infusionH ?? 1, 1 / 60);
        infusions.push({ start: t, end: t + dur, drug: i, rate: amt / dur });
      } else if (r.route === 'iv_bolus') {
        events.push({ t, drug: i, amount: amt, target: 'central' });
      } else {
        events.push({ t: t + (r.route === 'po' ? params[i].tlag : 0), drug: i, amount: amt * F, target: 'gut' });
      }
    }
  }
  events.sort((a, b) => a.t - b.t);
  // sc dosing uses ka; for drugs without oral ka (e.g. ka 0) use 1/h.
  const kaEff = params.map((p) => (p.ka > 0 ? p.ka : 1));

  // ---- interaction wiring
  const inhibitorsBy: Record<string, Perp[]> = {};
  const inducersBy: Record<string, { j: number; emax: number; ec50: number }[]> = {};
  for (const pw of PATHWAYS) {
    inhibitorsBy[pw] = [];
    inducersBy[pw] = [];
  }
  drugs.forEach((d, j) => {
    for (const inh of d.inhibits) {
      const a = INHIBITION_RESIDUAL[inh.strength];
      inhibitorsBy[inh.pathway].push({ j, ki: (refs[j] * a) / (1 - a) });
      if (inh.pathway === 'CYP3A4') inhibitorsBy.CYP3A5.push({ j, ki: (refs[j] * a) / (1 - a) });
    }
    for (const ind of d.induces) {
      const fold = INDUCTION_FOLD[ind.strength];
      inducersBy[ind.pathway].push({ j, emax: 2 * (fold - 1), ec50: refs[j] });
      if (ind.pathway === 'CYP3A4') inducersBy.CYP3A5.push({ j, emax: 2 * (fold - 1), ec50: refs[j] });
    }
  });
  const activePathways = PATHWAYS.filter((p) => inhibitorsBy[p].length || inducersBy[p].length);
  const renalPerps = drugs.map((d) =>
    RENAL_INTERACTIONS.filter((x) => x.victim === d.id && ids.includes(x.perpetrator)).map((x) => ({
      j: ids.indexOf(x.perpetrator),
      factor: x.factor,
    })),
  );
  const pdEC50 = drugs.map((d) => (d.pd ? d.pd.EC50 * (d.id === 'warfarin' ? VKORC1_EC50_FACTOR[patient.vkorc1] : 1) : 1));

  // ---- state: per drug [gut, central, periph, ce] + enzymes
  const NS = 4;
  const ne = activePathways.length;
  const size = n * NS + ne;
  let y = new Float64Array(size);
  if (input.initial) {
    drugs.forEach((d, i) => {
      const s = input.initial!.drugs[d.id];
      if (s) {
        y[i * NS] = s.gut;
        y[i * NS + 1] = s.central;
        y[i * NS + 2] = s.periph;
        y[i * NS + 3] = s.ce;
      }
    });
  }
  activePathways.forEach((pw, e) => (y[n * NS + e] = input.initial?.enzymes[pw] ?? 1));

  const modulation = new Float64Array(PATHWAYS.length);
  const pwIndex: Record<string, number> = Object.fromEntries(PATHWAYS.map((p, i) => [p, i]));
  const conc = new Float64Array(n);

  function computeModulation(s: Float64Array) {
    for (let i = 0; i < n; i++) conc[i] = Math.max(s[i * NS + 1], 0) / params[i].Vc;
    modulation.fill(1);
    for (let e = 0; e < ne; e++) {
      const pw = activePathways[e];
      let m = Math.max(s[n * NS + e], 0.05);
      for (const inh of inhibitorsBy[pw]) m /= 1 + conc[inh.j] / inh.ki;
      modulation[pwIndex[pw]] = m;
    }
  }

  function clearanceAt(i: number): number {
    const p = params[i];
    const sh = p.shares;
    const pgp = modulation[pwIndex.Pgp];
    let renal = sh.renal * (1 - sh.renalPgp + sh.renalPgp * pgp);
    for (const rp of renalPerps[i]) {
      const c = conc[rp.j];
      renal *= 1 - (1 - rp.factor) * (c / (c + refs[rp.j] * 0.25));
    }
    let cl = renal + sh.other;
    for (const pw of sh.pathways) cl += pw.f * modulation[pwIndex[pw.pathway]];
    return cl;
  }

  function hepaticModulation(i: number): number {
    // composite modulation of non-renal capacity, for Michaelis–Menten drugs
    const d = drugs[i];
    let fm = 0;
    let s = 0;
    for (const m of d.metabolism) {
      fm += m.fm;
      s += m.fm * modulation[pwIndex[m.pathway]];
    }
    return s + Math.max(0, 1 - fm);
  }

  function activation(i: number): number {
    const pd = drugs[i].prodrug;
    if (!pd) return 1;
    const act = phys.enzymeActivity[pd.pathway] * modulation[pwIndex[pd.pathway]];
    return 1 - pd.share + pd.share * act;
  }

  const infRate = new Float64Array(n);
  function deriv(s: Float64Array, out: Float64Array) {
    computeModulation(s);
    for (let i = 0; i < n; i++) {
      const p = params[i];
      const o = i * NS;
      const gut = s[o];
      const A = s[o + 1];
      const Ap = s[o + 2];
      const C = Math.max(A, 0) / p.Vc;
      const absorb = kaEff[i] * gut;
      let elim: number;
      if (p.vmax !== undefined && p.km !== undefined) {
        elim = (p.vmax * hepaticModulation(i) * C) / (p.km + C);
      } else {
        elim = clearanceAt(i) * C;
      }
      const dist = p.Vp > 0 ? p.Q * (C - Ap / p.Vp) : 0;
      out[o] = -absorb;
      out[o + 1] = absorb + infRate[i] - elim - dist;
      out[o + 2] = dist;
      const ke0 = drugs[i].pd?.ke0 ?? 1;
      out[o + 3] = ke0 * (C * activation(i) - s[o + 3]);
    }
    for (let e = 0; e < ne; e++) {
      const pw = activePathways[e];
      let stim = 1;
      for (const ind of inducersBy[pw]) stim += (ind.emax * conc[ind.j]) / (ind.ec50 + conc[ind.j]);
      out[n * NS + e] = ENZYME_KDEG * (stim - s[n * NS + e]);
    }
  }

  // ---- step size
  let kmax = ENZYME_KDEG;
  params.forEach((p, i) => {
    kmax = Math.max(kmax, kaEff[i], p.CL / p.Vc, p.Vp > 0 ? p.Q / p.Vc : 0, p.vmax ? p.vmax / (p.km! * p.Vc) : 0, drugs[i].pd?.ke0 ?? 1);
  });
  let dt = input.dt ?? Math.min(Math.max(0.3 / kmax, 0.004), 0.25);
  const maxSteps = 400000;
  if (durationH / dt > maxSteps) dt = durationH / maxSteps;

  // ---- breakpoints
  const breaks = new Set<number>();
  for (const e of events) breaks.add(e.t);
  for (const inf of infusions) {
    breaks.add(inf.start);
    breaks.add(inf.end);
  }
  const bp = Array.from(breaks).filter((t) => t > 0 && t < durationH).sort((a, b) => a - b);

  // fine-resolution storage
  const fineT: number[] = [];
  const fineC: Float64Array[] = [];
  const fineCe: Float64Array[] = [];
  const fineAct: Float64Array[] = [];
  const fineEnz: Float64Array[] = [];
  const estSteps = Math.ceil(durationH / dt) + bp.length * 2 + 4;
  for (let i = 0; i < n; i++) {
    fineC.push(new Float64Array(estSteps));
    fineCe.push(new Float64Array(estSteps));
    fineAct.push(new Float64Array(estSteps));
  }
  for (let e = 0; e < ne; e++) fineEnz.push(new Float64Array(estSteps));

  let evIdx = 0;
  function applyEvents(t: number) {
    while (evIdx < events.length && events[evIdx].t <= t + 1e-9) {
      const ev = events[evIdx++];
      y[ev.drug * NS + (ev.target === 'gut' ? 0 : 1)] += ev.amount;
    }
  }
  function setInfusion(t: number) {
    infRate.fill(0);
    for (const inf of infusions) if (t >= inf.start - 1e-9 && t < inf.end - 1e-9) infRate[inf.drug] += inf.rate;
  }
  let fi = 0;
  function record(t: number) {
    computeModulation(y);
    fineT.push(t);
    for (let i = 0; i < n; i++) {
      fineC[i][fi] = Math.max(y[i * NS + 1], 0) / params[i].Vc;
      fineCe[i][fi] = Math.max(y[i * NS + 3], 0);
      fineAct[i][fi] = activation(i);
    }
    for (let e = 0; e < ne; e++) fineEnz[e][fi] = y[n * NS + e];
    fi++;
  }

  const k1 = new Float64Array(size);
  const k2 = new Float64Array(size);
  const k3 = new Float64Array(size);
  const k4 = new Float64Array(size);
  const tmp = new Float64Array(size);

  let t = 0;
  let bpi = 0;
  applyEvents(0);
  record(0);
  while (t < durationH - 1e-9) {
    let next = Math.min(t + dt, durationH);
    while (bpi < bp.length && bp[bpi] <= t + 1e-9) bpi++;
    if (bpi < bp.length && bp[bpi] < next - 1e-9) next = bp[bpi];
    const h = next - t;
    setInfusion(t);
    deriv(y, k1);
    for (let k = 0; k < size; k++) tmp[k] = y[k] + 0.5 * h * k1[k];
    deriv(tmp, k2);
    for (let k = 0; k < size; k++) tmp[k] = y[k] + 0.5 * h * k2[k];
    deriv(tmp, k3);
    for (let k = 0; k < size; k++) tmp[k] = y[k] + h * k3[k];
    deriv(tmp, k4);
    const ny = new Float64Array(size);
    for (let k = 0; k < size; k++) ny[k] = y[k] + (h / 6) * (k1[k] + 2 * k2[k] + 2 * k3[k] + k4[k]);
    y = ny;
    t = next;
    applyEvents(t);
    if (fi >= fineC[0]?.length) break;
    record(t);
  }

  // ---- metrics
  const metrics: Record<string, DrugMetrics> = {};
  const F = fineT.length;
  computeModulation(y);
  drugs.forEach((d, i) => {
    const f = d.display.factor;
    const usesActive = !!d.prodrug;
    const C = (k: number) => fineC[i][k] * (usesActive ? fineAct[i][k] : 1);
    const tau = intervals[i];
    const winStart = lastDoseT[i] >= 0 ? Math.min(lastDoseT[i], durationH - 1e-6) : Math.max(0, durationH - tau);
    const winEnd = Math.min(winStart + tau, durationH);
    let cmax = 0;
    let tmax = 0;
    let cmin = Infinity;
    let aucTotal = 0;
    let auc24 = 0;
    let aucWin = 0;
    let peakLast = 0;
    let troughLast = Infinity;
    let inRange = 0;
    let toxicT = 0;
    const thLo = d.therapeutic ? exposureToConc(d, d.therapeutic.low, d.therapeutic.basis) : 0;
    const thHi = d.therapeutic ? exposureToConc(d, d.therapeutic.high, d.therapeutic.basis) : 0;
    const tox = d.toxic ? exposureToConc(d, d.toxic.value, d.toxic.basis) : Infinity;
    const day0 = Math.max(0, durationH - 24);
    for (let k = 0; k < F; k++) {
      const c = C(k);
      if (c > cmax) {
        cmax = c;
        tmax = fineT[k];
      }
      if (k > 0) {
        const h = fineT[k] - fineT[k - 1];
        const seg = 0.5 * (c + C(k - 1)) * h;
        aucTotal += seg;
        if (fineT[k - 1] >= day0 - 1e-9) auc24 += seg;
        if (fineT[k - 1] >= winStart - 1e-9 && fineT[k] <= winEnd + 1e-9) aucWin += seg;
        if (d.therapeutic && c >= thLo && c <= (d.therapeutic.basis === 'trough' ? Infinity : thHi * 1.0001)) inRange += h;
        if (c > tox) toxicT += h;
      }
      if (fineT[k] >= winStart - 1e-9 && fineT[k] <= winEnd + 1e-9) {
        peakLast = Math.max(peakLast, c);
        troughLast = Math.min(troughLast, c);
      }
      if (fineT[k] > 0.5) cmin = Math.min(cmin, c);
    }
    if (!isFinite(cmin)) cmin = 0;
    if (!isFinite(troughLast)) troughLast = C(F - 1);
    // Trough just before next dose is the end of the last interval.
    if (winEnd >= durationH - 1e-6) troughLast = Math.min(troughLast, C(F - 1));
    const winLen = Math.max(winEnd - winStart, 1e-6);
    const avgLast = aucWin / winLen;
    const span = Math.max(durationH, 1e-6);
    const p = params[i];
    const vtot = p.Vc + p.Vp;
    const finalC = fineC[i][F - 1];
    const clNow = p.vmax ? (p.vmax * hepaticModulation(i)) / (p.km! + finalC) : clearanceAt(i);
    const value = (b: ExposureBasis) =>
      b === 'trough' ? troughLast * f : b === 'peak' ? peakLast * f : b === 'average' ? avgLast * f : (durationH >= 24 ? auc24 : (aucWin * 24) / winLen) * f;
    let targetValue: number | null = null;
    let targetStatus: DrugMetrics['targetStatus'] = 'n/a';
    if (d.therapeutic) {
      targetValue = value(d.therapeutic.basis);
      targetStatus = targetValue < d.therapeutic.low ? 'below' : targetValue > d.therapeutic.high ? 'above' : 'within';
    }
    let toxicStatus: DrugMetrics['toxicStatus'] = 'n/a';
    if (d.toxic) toxicStatus = value(d.toxic.basis) > d.toxic.value ? 'toxic' : 'ok';
    metrics[d.id] = {
      drugId: d.id,
      unit: d.display.unit,
      cmax: cmax * f,
      tmax,
      cmin: cmin * f,
      troughLast: troughLast * f,
      peakLast: peakLast * f,
      avgLast: avgLast * f,
      auc24: (durationH >= 24 ? auc24 : (aucWin * 24) / winLen) * f,
      aucTotal: aucTotal * f,
      final: C(F - 1) * f,
      halfLifeH: (0.693 * vtot) / Math.max(clNow, 1e-9),
      clearanceLh: clNow,
      volumeL: vtot,
      timeInRangePct: d.therapeutic ? (100 * inRange) / span : null,
      timeToxicPct: d.toxic ? (100 * toxicT) / span : null,
      targetValue,
      targetStatus,
      toxicStatus,
      doseMg: doseMg[i],
      intervalH: intervals[i],
    };
  });

  const finalState: SimState = {
    drugs: Object.fromEntries(drugs.map((d, i) => [d.id, { gut: y[i * NS], central: y[i * NS + 1], periph: y[i * NS + 2], ce: y[i * NS + 3] }])),
    enzymes: Object.fromEntries(PATHWAYS.map((pw) => [pw, activePathways.includes(pw) ? y[n * NS + activePathways.indexOf(pw)] : (input.initial?.enzymes[pw] ?? 1)])) as Record<Pathway, number>,
  };

  const result: SimulationResult = {
    t: [],
    durationH,
    series: {},
    qtc: [],
    organs: Object.fromEntries(ORGANS.map((o) => [o, { therapeutic: [] as number[], risk: [] as number[] }])) as unknown as SimulationResult['organs'],
    enzymes: Object.fromEntries(PATHWAYS.map((p) => [p, [] as number[]])) as Record<Pathway, number[]>,
    metrics,
    params: Object.fromEntries(drugs.map((d, i) => [d.id, params[i]])),
    physiology: phys,
    finalState,
    drugIds: ids,
  };
  if (input.metricsOnly) return result;

  // ---- downsample to ≤ ~800 points
  const target = 800;
  const outStep = Math.max(durationH / target, dt);
  const sel: number[] = [];
  let nextT = 0;
  for (let k = 0; k < F; k++) {
    if (fineT[k] >= nextT - 1e-9 || k === F - 1) {
      sel.push(k);
      nextT = fineT[k] + outStep;
    }
  }
  // keep local peaks so the chart does not miss Cmax
  for (let i = 0; i < n; i++) {
    for (let k = 1; k < F - 1; k++) {
      if (fineC[i][k] > fineC[i][k - 1] && fineC[i][k] >= fineC[i][k + 1] && fineC[i][k] > 0.02 * (metrics[drugs[i].id].cmax / drugs[i].display.factor)) sel.push(k);
    }
  }
  const uniq = Array.from(new Set(sel)).sort((a, b) => a - b);
  result.t = uniq.map((k) => fineT[k]);

  drugs.forEach((d, i) => {
    const f = d.display.factor;
    const s: DrugSeries = { conc: uniq.map((k) => fineC[i][k] * f) };
    if (d.prodrug) s.active = uniq.map((k) => fineC[i][k] * fineAct[i][k] * f);
    if (d.pd) {
      const { E0, Emax, hill } = d.pd;
      const ec = pdEC50[i];
      s.effect = uniq.map((k) => {
        const ce = fineCe[i][k];
        return E0 + (Emax * ce ** hill) / (ec ** hill + ce ** hill);
      });
    }
    result.series[d.id] = s;
  });

  // QTc
  const hypoK = patient.potassium < 3.5 ? 10 : 0;
  result.qtc = uniq.map((k) => {
    let q = phys.baselineQTc + hypoK;
    drugs.forEach((d, i) => {
      if (d.qt.maxMs > 0) q += (d.qt.maxMs * fineC[i][k]) / (fineC[i][k] + refs[i]);
    });
    return q;
  });

  // Enzyme activity series (modulated by inhibition)
  for (const pw of PATHWAYS) {
    const e = activePathways.indexOf(pw);
    result.enzymes[pw] = uniq.map((k) => {
      let m = e >= 0 ? fineEnz[e][k] : 1;
      for (const inh of inhibitorsBy[pw]) m /= 1 + fineC[inh.j][k] / inh.ki;
      return m * phys.enzymeActivity[pw];
    });
  }

  // Organ load: therapeutic engagement (fractional effect) and toxicity risk (sigmoid on toxic threshold)
  for (const organ of ORGANS) {
    const ther: number[] = new Array(uniq.length).fill(0);
    const risk: number[] = new Array(uniq.length).fill(0);
    drugs.forEach((d, i) => {
      const targets = d.organs.filter((o) => o.organ === organ);
      if (!targets.length) return;
      const isTarget = targets.some((o) => o.kind === 'target');
      const isAdverse = targets.some((o) => o.kind === 'adverse');
      const ref = refs[i];
      const tox = d.toxic ? exposureToConc(d, d.toxic.value, d.toxic.basis) : ref * 4;
      uniq.forEach((k, idx) => {
        const c = fineC[i][k] * fineAct[i][k];
        if (isTarget) {
          const occ = d.pd ? fineCe[i][k] ** d.pd.hill / (pdEC50[i] ** d.pd.hill + fineCe[i][k] ** d.pd.hill) : c / (c + ref);
          ther[idx] = Math.max(ther[idx], occ);
        }
        if (isAdverse) {
          const x = (c / tox) ** 4;
          const r = 1 - (1 - risk[idx]) * (1 - x / (1 + x));
          risk[idx] = r;
        }
      });
    });
    result.organs[organ] = { therapeutic: ther, risk };
  }
  return result;
}

/** Generate a simple regimen. */
export function makeRegimen(drugId: string, overrides: Partial<Regimen> = {}): Regimen {
  const d = getDrug(drugId);
  const r = d.defaultRegimen;
  return {
    id: `${drugId}-${Math.random().toString(36).slice(2, 8)}`,
    drugId,
    dose: r.dose,
    unit: r.unit,
    intervalH: r.intervalH,
    route: r.route,
    infusionH: r.infusionH,
    startH: 0,
    doses: Math.max(1, Math.round((24 * 7) / r.intervalH)),
    ...overrides,
  };
}
