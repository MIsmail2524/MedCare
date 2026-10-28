import { getDrug } from './drugs.js';
import { derivePhysiology, PROCEDURE_MAP } from './physiology.js';
import { doseInMg, ORGANS, simulate } from './pk.js';
import type { SimState, SimulationResult } from './pk.js';
import type { Organ, Pathway, Patient, Regimen } from './types.js';

export interface CumulativeExposure {
  drugId: string;
  totalMg: number;
  totalPerM2: number;
  totalPerKg: number;
  limit?: { value: number; unit: string; organ: Organ; note: string; pct: number };
  courses: number;
  days: number;
}

export interface ResidualLevel {
  drugId: string;
  value: number;
  unit: string;
  pctOfTherapeuticLow: number | null;
  daysToWashout: number;
}

export interface LastingEffect {
  source: string;
  kind: 'procedure' | 'cumulative' | 'enzyme' | 'residual';
  organ?: Organ | string;
  severity: 'info' | 'moderate' | 'major';
  text: string;
}

export interface HistoryAnalysis {
  windowStart: string | null;
  now: string;
  cumulative: CumulativeExposure[];
  residual: ResidualLevel[];
  lasting: LastingEffect[];
  organBurden: Record<Organ, number>;
  carryOver: SimState | null;
  timeline: SimulationResult | null;
  enzymeState: Partial<Record<Pathway, number>>;
}

const HOUR = 3600000;

/** Convert dated medication courses into simulation regimens relative to an origin. */
export function coursesToRegimens(patient: Patient, origin: Date, until: Date): Regimen[] {
  const regs: Regimen[] = [];
  for (const c of patient.medicationHistory) {
    const s = new Date(c.start).getTime();
    const e = Math.min(new Date(c.end).getTime(), until.getTime());
    if (!(e > s) || !c.intervalH) continue;
    const doses = Math.floor((e - s) / HOUR / c.intervalH) + 1;
    regs.push({
      id: c.id,
      drugId: c.drugId,
      dose: c.dose,
      unit: c.unit,
      intervalH: c.intervalH,
      route: c.route,
      infusionH: c.infusionH,
      startH: (s - origin.getTime()) / HOUR,
      doses: Math.min(doses, 5000),
    });
  }
  return regs;
}

/** Regimens for courses overlapping [origin, until]; doses before `origin` are dropped. */
export function windowRegimens(patient: Patient, origin: Date, until: Date): Regimen[] {
  return coursesToRegimens(patient, origin, until)
    .map((r) => {
      if (r.startH >= 0) return r;
      const skip = Math.ceil(-r.startH / r.intervalH);
      return { ...r, startH: r.startH + skip * r.intervalH, doses: r.doses - skip };
    })
    .filter((r) => r.doses > 0);
}

/**
 * Retrospective analysis: what effects have past medicines and procedures already had on the twin?
 * Reconstructs drug exposure from the medication history up to `now`, giving residual levels,
 * carried-over enzyme induction/inhibition, cumulative-dose toxicity and lasting physiological changes.
 */
export function analyzeHistory(patient: Patient, now: Date = new Date()): HistoryAnalysis {
  const phys = derivePhysiology(patient, now);
  const lasting: LastingEffect[] = [];
  const organBurden = Object.fromEntries(ORGANS.map((o) => [o, 0])) as Record<Organ, number>;

  // Procedures
  for (const p of patient.procedures) {
    const def = PROCEDURE_MAP[p.type];
    if (!def) continue;
    const days = Math.round((now.getTime() - new Date(p.date).getTime()) / 86400000);
    if (days < 0) continue;
    for (const a of def.alerts) lasting.push({ source: `${def.name} (${days} d ago)`, kind: 'procedure', organ: def.organs[0], severity: 'moderate', text: a });
    for (const o of def.organs) if (o in organBurden) organBurden[o as Organ] = Math.max(organBurden[o as Organ], 0.35);
  }

  // Cumulative exposure (all history, including older than the simulation window)
  const cumMap = new Map<string, CumulativeExposure>();
  for (const c of patient.medicationHistory) {
    const d = getDrug(c.drugId);
    const s = new Date(c.start).getTime();
    const e = Math.min(new Date(c.end).getTime(), now.getTime());
    if (!(e > s)) continue;
    const doses = Math.floor((e - s) / HOUR / c.intervalH) + 1;
    const mg = doseInMg(d, c.dose, c.unit, patient, phys) * doses;
    const prev = cumMap.get(c.drugId) ?? { drugId: c.drugId, totalMg: 0, totalPerM2: 0, totalPerKg: 0, courses: 0, days: 0 };
    prev.totalMg += mg;
    prev.totalPerM2 = prev.totalMg / phys.bsa;
    prev.totalPerKg = prev.totalMg / patient.weightKg;
    prev.courses += 1;
    prev.days += (e - s) / 86400000;
    cumMap.set(c.drugId, prev);
  }
  for (const ce of cumMap.values()) {
    const d = getDrug(ce.drugId);
    if (d.cumulativeLimit) {
      const v = d.cumulativeLimit.unit === 'mg/m2' ? ce.totalPerM2 : d.cumulativeLimit.unit === 'mg/kg' ? ce.totalPerKg : ce.totalMg;
      const pct = (100 * v) / d.cumulativeLimit.value;
      ce.limit = { ...d.cumulativeLimit, pct };
      organBurden[d.cumulativeLimit.organ] = Math.max(organBurden[d.cumulativeLimit.organ], Math.min(pct / 100, 1));
      if (pct >= 50) {
        lasting.push({
          source: d.name,
          kind: 'cumulative',
          organ: d.cumulativeLimit.organ,
          severity: pct >= 100 ? 'major' : 'moderate',
          text: `Cumulative dose ${v.toFixed(0)} ${d.cumulativeLimit.unit} = ${pct.toFixed(0)}% of the ${d.cumulativeLimit.value} ${d.cumulativeLimit.unit} threshold. ${d.cumulativeLimit.note}.`,
        });
      }
    }
  }

  // Reconstruct exposure over the last ≤ 365 days
  const yearAgo = now.getTime() - 365 * 86400000;
  const starts = patient.medicationHistory.map((c) => new Date(c.start).getTime()).filter((t) => t < now.getTime());
  let timeline: SimulationResult | null = null;
  let carryOver: SimState | null = null;
  const residual: ResidualLevel[] = [];
  const enzymeState: Partial<Record<Pathway, number>> = {};
  let windowStart: string | null = null;
  if (starts.length) {
    const origin = new Date(Math.max(Math.min(...starts), yearAgo));
    windowStart = origin.toISOString();
    // courses that started before the window keep only the doses inside it
    const regs = windowRegimens(patient, origin, now);
    const durationH = (now.getTime() - origin.getTime()) / HOUR;
    if (regs.length && durationH > 0) {
      timeline = simulate({ patient, physiology: phys, regimens: regs, durationH, at: now });
      carryOver = timeline.finalState;
      for (const [pw, v] of Object.entries(carryOver.enzymes)) {
        if (Math.abs(v - 1) > 0.1) {
          enzymeState[pw as Pathway] = v;
          lasting.push({
            source: 'Enzyme carry-over',
            kind: 'enzyme',
            severity: Math.abs(v - 1) > 0.5 ? 'major' : 'moderate',
            text: `${pw} activity is currently ${v.toFixed(2)}× baseline due to prior ${v > 1 ? 'induction' : 'inhibition'}; it normalises with a ~36 h enzyme half-life.`,
          });
        }
      }
      for (const id of timeline.drugIds) {
        const d = getDrug(id);
        const m = timeline.metrics[id];
        const val = m.final;
        if (val <= 0) continue;
        const thLow = d.therapeutic && d.therapeutic.basis !== 'auc24' ? d.therapeutic.low : null;
        const t12 = m.halfLifeH;
        const floor = (thLow ?? m.cmax) * 0.05;
        const daysToWashout = val > floor ? (t12 * Math.log2(val / floor)) / 24 : 0;
        residual.push({ drugId: id, value: val, unit: d.display.unit, pctOfTherapeuticLow: thLow ? (100 * val) / thLow : null, daysToWashout });
        const ongoing = patient.medicationHistory.some((c) => c.drugId === id && new Date(c.end).getTime() >= now.getTime() - 86400000);
        if (ongoing) {
          lasting.push({
            source: d.name,
            kind: 'residual',
            severity: 'info',
            text: `Currently taking — present level ${val.toPrecision(2)} ${d.display.unit}${thLow ? ` (${((100 * val) / thLow).toFixed(0)}% of therapeutic low)` : ''}. Future simulations start from this state.`,
          });
        } else if (thLow && val >= 0.25 * thLow) {
          lasting.push({
            source: d.name,
            kind: 'residual',
            severity: d.inhibits.length || d.induces.length ? 'major' : 'moderate',
            text: `Residual level ${val.toPrecision(2)} ${d.display.unit} (${((100 * val) / thLow).toFixed(0)}% of therapeutic low) — still pharmacologically active; ≈ ${daysToWashout.toFixed(0)} days to fall below 5% of the therapeutic level.`,
          });
        }
      }
      for (const o of ORGANS) {
        const r = timeline.organs[o].risk;
        if (!r.length) continue;
        const mean = r.reduce((s, v) => s + v, 0) / r.length;
        const peak = Math.max(...r);
        organBurden[o] = Math.max(organBurden[o], 0.5 * mean + 0.5 * peak);
      }
    }
  }
  return { windowStart, now: now.toISOString(), cumulative: Array.from(cumMap.values()), residual, lasting, organBurden, carryOver, timeline, enzymeState };
}
