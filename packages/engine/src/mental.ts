import { getDrug } from './drugs.js';
import { simulate } from './pk.js';
import type { Patient, Regimen } from './types.js';

// Mental-health twin: plasma exposure → brain target occupancy (PET-calibrated hyperbolic models),
// time inside the occupancy window associated with response without adverse effects, and a
// response-probability forecast that also reflects pharmacogenomic exposure changes.

export interface OccupancyModel {
  drugId: string;
  target: string;
  /** plasma concentration (ng/mL) giving 50 % occupancy */
  ec50: number;
  window: [number, number];
  adverseAbove?: { threshold: number; effect: string };
  source: string;
}

export const OCCUPANCY: OccupancyModel[] = [
  { drugId: 'haloperidol', target: 'Striatal D2 receptor', ec50: 0.85, window: [0.65, 0.78], adverseAbove: { threshold: 0.78, effect: 'extrapyramidal symptoms; hyperprolactinaemia > 72 %' }, source: 'Kapur et al. Am J Psychiatry 2000; Nyberg 1995 (PET)' },
  { drugId: 'citalopram', target: 'Serotonin transporter (SERT)', ec50: 8, window: [0.8, 0.95], adverseAbove: { threshold: 0.95, effect: 'no added efficacy; QT and serotonergic toxicity rise with dose' }, source: 'Meyer et al. Am J Psychiatry 2004 (SERT ~80 % at minimum therapeutic dose)' },
  { drugId: 'fluoxetine', target: 'Serotonin transporter (SERT)', ec50: 15, window: [0.8, 0.95], source: 'Meyer et al. 2004' },
  { drugId: 'methadone', target: 'μ-opioid receptor', ec50: 60, window: [0.5, 0.9], adverseAbove: { threshold: 0.9, effect: 'respiratory depression' }, source: 'Approximate PET/withdrawal-suppression relationship' },
];

export interface OccupancyResult {
  model: OccupancyModel;
  t: number[];
  occupancy: number[];
  timeInWindow: number;
  timeAbove: number;
  troughOccupancy: number;
  pResponse: number;
}

export function occupancyForecast(patient: Patient, regimen: Regimen): OccupancyResult {
  const model = OCCUPANCY.find((m) => m.drugId === regimen.drugId);
  if (!model) throw new Error('No occupancy model for this drug');
  const d = getDrug(regimen.drugId);
  const sim = simulate({ patient, regimens: [regimen] });
  const ngml = sim.series[regimen.drugId].conc.map((c) => (c / d.display.factor) * 1000);
  const occ = ngml.map((c) => c / (c + model.ec50));
  const start = sim.durationH * 0.5; // judge the second half (approaching steady state)
  let inW = 0, above = 0, span = 0, trough = 1;
  for (let k = 1; k < sim.t.length; k++) {
    if (sim.t[k] < start) continue;
    const dt = sim.t[k] - sim.t[k - 1];
    span += dt;
    if (occ[k] >= model.window[0] && occ[k] <= model.window[1]) inW += dt;
    if (model.adverseAbove && occ[k] > model.adverseAbove.threshold) above += dt;
    trough = Math.min(trough, occ[k]);
  }
  // Response probability rises steeply once trough occupancy exceeds the lower window bound.
  const pResponse = 0.25 + 0.45 / (1 + Math.exp(-(trough - model.window[0]) * 30));
  return { model, t: sim.t, occupancy: occ, timeInWindow: inW / Math.max(span, 1e-9), timeAbove: above / Math.max(span, 1e-9), troughOccupancy: trough, pResponse };
}
