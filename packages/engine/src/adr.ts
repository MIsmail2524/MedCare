import { DRUG_MAP, getDrug, isDrugId } from './drugs.js';
import { derivePhysiology } from './physiology.js';
import { exposureToConc, simulate } from './pk.js';
import { windowRegimens } from './history.js';
import { findKBDrug, type SafetyKB } from './safety.js';
import type { MedicationCourse, Organ, Patient } from './types.js';

// Model-based adverse drug reaction causality ("reverse twin"): given a clinical event, rank the
// medicines the patient took by how well each explains it — prior organ liability (FDA label +
// FAERS disproportionality), temporal plausibility (exposure at onset and organ-specific latency),
// dose–response (simulated concentration vs. toxic threshold) and interaction-driven exposure.

export interface ADREvent {
  organ: Organ;
  onset: string; // ISO date-time
  severity: 'mild' | 'moderate' | 'severe' | 'life-threatening';
  description?: string;
}

export interface ADRMedication {
  /** Name as in the knowledge base, or a simulator drug id */
  name: string;
  drugId?: string;
  start: string;
  end?: string;
  dose?: number;
  intervalH?: number;
}

/** Typical latency from first exposure to onset (days) for drug-induced events by organ. */
export const ONSET_WINDOWS: Record<Organ, [number, number]> = {
  skin: [4, 56],
  liver: [5, 90],
  blood: [5, 90],
  heart: [0, 21],
  kidneys: [1, 21],
  lungs: [0, 120],
  brain: [0, 21],
  gi: [0, 21],
  pancreas: [7, 180],
  muscle: [3, 120],
  thyroid: [30, 365],
};

export const ANTIDOTES: Record<string, string> = {
  acetaminophen: 'N-acetylcysteine (Rumack–Matthew nomogram; 21-h IV protocol).',
  morphine: 'Naloxone 0.04–0.4 mg IV titrated to respiration.',
  fentanyl: 'Naloxone (may need repeated doses / infusion).',
  methadone: 'Naloxone infusion — long half-life requires prolonged observation.',
  codeine: 'Naloxone.',
  oxycodone: 'Naloxone.',
  hydromorphone: 'Naloxone.',
  tramadol: 'Naloxone (partial); benzodiazepine for seizures.',
  midazolam: 'Supportive airway care; flumazenil only in selected cases (seizure risk).',
  lorazepam: 'Supportive care; flumazenil in selected cases.',
  diazepam: 'Supportive care; flumazenil in selected cases.',
  warfarin: 'Hold warfarin; vitamin K 5–10 mg IV; 4-factor PCC for major bleeding.',
  apixaban: 'Andexanet alfa or 4-factor PCC for life-threatening bleeding.',
  rivaroxaban: 'Andexanet alfa or 4-factor PCC.',
  dabigatran: 'Idarucizumab 5 g IV.',
  heparin: 'Protamine sulfate 1 mg per 100 units.',
  enoxaparin: 'Protamine (partial reversal, ~60%).',
  digoxin: 'Digoxin-specific Fab fragments; correct potassium and magnesium.',
  methotrexate: 'Leucovorin rescue; glucarpidase if renal failure; hydration and urinary alkalinisation.',
  lithium: 'Stop lithium; IV fluids; haemodialysis for severe toxicity or level > 4 mmol/L.',
  'lithium carbonate': 'Stop lithium; IV fluids; haemodialysis for severe toxicity.',
  vancomycin: 'Stop; supportive care; consider haemodialysis with high-flux membranes in severe AKI.',
  gentamicin: 'Stop; monitor renal function and hearing; haemodialysis in severe accumulation.',
  phenytoin: 'Supportive; stop drug; manage ataxia/arrhythmia.',
  theophylline: 'Activated charcoal; beta-blockade for tachyarrhythmia; haemodialysis in severe toxicity.',
  carbamazepine: 'Multiple-dose activated charcoal; supportive care.',
  valproate: 'L-carnitine for hyperammonaemia / hepatotoxicity.',
  'valproic acid': 'L-carnitine for hyperammonaemia / hepatotoxicity.',
  metformin: 'Stop; haemodialysis for metformin-associated lactic acidosis.',
  insulin: 'Glucose IV; glucagon.',
  'insulin glargine': 'Glucose IV; glucagon.',
  amiodarone: 'Stop; corticosteroids for pulmonary toxicity; very long washout (half-life ~50 days).',
};

export const ORGAN_MANAGEMENT: Record<Organ, string[]> = {
  liver: ['Measure ALT, AST, ALP, bilirubin, INR; calculate R-ratio (hepatocellular vs cholestatic).', 'Stop the suspected drug if ALT > 5× ULN, or > 3× ULN with bilirubin > 2× ULN (Hy’s law).', 'Exclude viral hepatitis, biliary obstruction and ischaemia.'],
  kidneys: ['Check creatinine, urea, electrolytes, urinalysis (eosinophils, casts).', 'Stop or dose-adjust nephrotoxins; restore volume; avoid NSAIDs/contrast.', 'Re-dose renally cleared drugs for current eGFR.'],
  heart: ['12-lead ECG (QTc, rhythm); continuous monitoring if QTc > 500 ms.', 'Correct K⁺ ≥ 4.0 and Mg²⁺ ≥ 2.0; stop QT-prolonging drugs.', 'IV magnesium for torsades de pointes; pacing / isoproterenol if recurrent.'],
  blood: ['CBC with differential, coagulation (INR/aPTT); identify bleeding source.', 'Stop the suspected drug; G-CSF for severe neutropenia; transfusion as needed.', 'Reverse anticoagulation where applicable.'],
  skin: ['Assess mucosal involvement, skin detachment (SCORTEN), eosinophilia and organ involvement (DRESS).', 'Stop the culprit drug immediately; never rechallenge after SJS/TEN.', 'Refer to burns/dermatology unit for SJS/TEN; systemic steroids for DRESS.'],
  brain: ['Neurological examination; consider drug levels, glucose, sodium, ammonia.', 'Reduce or stop CNS-active drugs; seizure precautions.', 'For serotonin syndrome: stop serotonergic drugs, cyproheptadine, cooling.'],
  lungs: ['SpO₂, respiratory rate, blood gas; chest imaging for pneumonitis.', 'Reverse opioids/sedatives (naloxone) if respiratory depression.', 'Stop drug and consider corticosteroids for drug-induced pneumonitis.'],
  gi: ['Assess for bleeding (haemoglobin, stool), dehydration and C. difficile.', 'Proton-pump inhibitor for NSAID ulceration; stop causative agent.', 'Fluids and electrolyte replacement.'],
  pancreas: ['Lipase, glucose, triglycerides; abdominal imaging.', 'Stop the suspected drug; supportive care.', 'Treat hypo-/hyperglycaemia.'],
  muscle: ['CK, creatinine, urine myoglobin.', 'Stop statin/other myotoxin; aggressive IV fluids for rhabdomyolysis.', 'Check for interacting CYP3A4 inhibitors.'],
  thyroid: ['TSH, free T4/T3.', 'Replace or block thyroid hormone as indicated; endocrinology review.', 'Reassess need for the causative drug.'],
};

export interface CausalityCandidate {
  name: string;
  drugId?: string;
  posterior: number;
  category: 'probable' | 'possible' | 'unlikely';
  factors: { prior: number; temporal: number; exposure: number; interaction: number };
  latencyDays: number | null;
  exposureRatio: number | null;
  explanation: string[];
  antidote?: string;
}

export interface CausalityResult {
  event: ADREvent;
  candidates: CausalityCandidate[];
  otherCauses: number;
  management: string[];
  dechallenge: { drugId: string; t: number[]; continued: number[]; stopped: number[]; unit: string; threshold: number | null; hoursToBelowThreshold: number | null } | null;
}

const DAY = 86400000;

function labelPrior(kb: SafetyKB | null, name: string, drugId: string | undefined, organ: Organ): { p: number; why: string } {
  const k = kb ? findKBDrug(kb, name) : undefined;
  if (k) {
    const o = k.organs[organ];
    let p = o.label === 2 ? 0.6 : o.label === 1 ? 0.35 : 0.06;
    let why = o.label === 2 ? 'Boxed warning names this organ' : o.label === 1 ? 'Label warnings name this organ' : 'Not in label warnings';
    if (o.prr >= 2 && o.count >= 10) {
      p = Math.min(0.9, p * Math.min(3, o.prr / 1.5));
      why += `; FAERS disproportionality PRR ${o.prr.toFixed(1)} (n=${o.count})`;
    }
    return { p, why };
  }
  if (drugId && isDrugId(drugId)) {
    const d = getDrug(drugId);
    const listed = d.organs.some((x) => x.organ === organ && x.kind === 'adverse');
    return { p: listed ? 0.35 : 0.06, why: listed ? 'Known organ toxicity in the twin drug model' : 'No known toxicity for this organ' };
  }
  return { p: 0.08, why: 'No safety data available — population base rate used' };
}

/** Rank suspected drugs for an adverse event. */
export function assessCausality(patient: Patient, event: ADREvent, meds: ADRMedication[], kb: SafetyKB | null): CausalityResult {
  const onset = new Date(event.onset).getTime();
  const phys = derivePhysiology(patient, new Date(event.onset));
  const [w0, w1] = ONSET_WINDOWS[event.organ];

  // Exposure at onset for drugs with a PK model.
  const pkMeds = meds.filter((m) => m.drugId && isDrugId(m.drugId) && m.dose && m.intervalH && !m.drugId.startsWith('cand:'));
  const courses: MedicationCourse[] = pkMeds.map((m, i) => ({
    id: `m${i}`,
    drugId: m.drugId!,
    dose: m.dose!,
    unit: getDrug(m.drugId!).defaultRegimen.unit,
    intervalH: m.intervalH!,
    route: getDrug(m.drugId!).defaultRegimen.route,
    infusionH: getDrug(m.drugId!).defaultRegimen.infusionH,
    start: m.start,
    end: m.end ?? event.onset,
  }));
  let atOnset: Record<string, number> = {};
  let solo: Record<string, number> = {};
  if (courses.length) {
    // Simulation window: at most 300 days before onset (long-ago doses no longer matter).
    const origin = new Date(Math.max(Math.min(...courses.map((c) => new Date(c.start).getTime())), onset - 300 * DAY));
    const p2 = { ...patient, medicationHistory: courses };
    const regs = windowRegimens(p2, origin, new Date(event.onset));
    const dur = Math.max(1, (onset - origin.getTime()) / 3600000);
    if (regs.length) {
      const sim = simulate({ patient, physiology: phys, regimens: regs, durationH: dur, metricsOnly: true });
      atOnset = Object.fromEntries(Object.entries(sim.finalState.drugs).map(([id, s]) => [id, Math.max(s.central, 0) / sim.params[id].Vc]));
      for (const r of regs) {
        const s1 = simulate({ patient, physiology: phys, regimens: regs.filter((x) => x.drugId === r.drugId), durationH: dur, metricsOnly: true });
        solo[r.drugId] = Math.max(s1.finalState.drugs[r.drugId].central, 0) / s1.params[r.drugId].Vc;
      }
    }
  }

  const raw: CausalityCandidate[] = meds.map((m) => {
    const start = new Date(m.start).getTime();
    const end = m.end ? new Date(m.end).getTime() : Infinity;
    const latency = (onset - start) / DAY;
    const prior = labelPrior(kb, m.name, m.drugId, event.organ);
    const why = [prior.why];
    let temporal = 1;
    if (latency < 0) {
      temporal = 0.02;
      why.push('Started after the event — temporally implausible');
    } else {
      let washout = 30;
      if (m.drugId && isDrugId(m.drugId)) {
        const d = getDrug(m.drugId);
        const t12 = (0.693 * (d.pk.Vc + (d.pk.Vp ?? 0)) * 70) / Math.max(d.pk.CL || 1, 1e-6);
        washout = Math.max(1, (5 * t12) / 24);
      }
      const sinceStop = (onset - end) / DAY;
      if (sinceStop > washout) {
        temporal = 0.12;
        why.push(`Stopped ${Math.round(sinceStop)} d before onset (> 5 half-lives)`);
      } else if (latency >= w0 && latency <= w1) {
        why.push(`Latency ${latency.toFixed(latency < 2 ? 1 : 0)} d fits the typical ${w0}–${w1} d window for ${event.organ} reactions`);
      } else {
        temporal = 0.45;
        why.push(`Latency ${latency.toFixed(latency < 2 ? 1 : 0)} d is outside the typical ${w0}–${w1} d window`);
      }
    }
    let exposure = 0.75;
    let ratio: number | null = null;
    let interaction = 1;
    if (m.drugId && atOnset[m.drugId] !== undefined) {
      const d = getDrug(m.drugId);
      const tox = d.toxic ? exposureToConc(d, d.toxic.value, d.toxic.basis) : null;
      if (tox) {
        ratio = atOnset[m.drugId] / tox;
        exposure = 0.3 + 0.7 / (1 + Math.exp(-(2.5 * Math.log(Math.max(ratio, 1e-3)) + 1)));
        why.push(`Simulated level at onset ${(atOnset[m.drugId] * d.display.factor).toPrecision(2)} ${d.display.unit} = ${(ratio * 100).toFixed(0)}% of toxic threshold`);
      }
      const fold = solo[m.drugId] > 0 ? atOnset[m.drugId] / solo[m.drugId] : 1;
      if (fold >= 1.4) {
        interaction = Math.min(1.8, fold ** 0.5);
        why.push(`Co-medication raised its level ${fold.toFixed(1)}× (drug–drug interaction)`);
      }
    }
    const score = prior.p * temporal * exposure * interaction;
    return {
      name: m.name,
      drugId: m.drugId,
      posterior: score,
      category: 'unlikely' as const,
      factors: { prior: prior.p, temporal, exposure, interaction },
      latencyDays: latency >= 0 ? latency : null,
      exposureRatio: ratio,
      explanation: why,
      antidote: ANTIDOTES[(m.drugId && DRUG_MAP[m.drugId]?.id) || m.name.toLowerCase()] ?? ANTIDOTES[m.name.toLowerCase()],
    };
  });
  const otherCauses = 0.12 * (event.severity === 'mild' ? 1.5 : 1);
  const total = raw.reduce((s, c) => s + c.posterior, 0) + otherCauses;
  const candidates = raw
    .map((c) => {
      const posterior = c.posterior / total;
      return { ...c, posterior, category: (posterior >= 0.5 ? 'probable' : posterior >= 0.2 ? 'possible' : 'unlikely') as CausalityCandidate['category'] };
    })
    .sort((a, b) => b.posterior - a.posterior);

  const top = candidates[0];
  const management = [
    ...(top && top.category !== 'unlikely' ? [`Most likely culprit: ${top.name} (${Math.round(top.posterior * 100)}%). Consider dechallenge (stop or reduce) unless benefit clearly outweighs harm.`] : ['No single drug clearly explains the event — evaluate non-drug causes.']),
    ...(top?.antidote ? [`Specific treatment: ${top.antidote}`] : []),
    ...ORGAN_MANAGEMENT[event.organ],
    event.severity === 'severe' || event.severity === 'life-threatening' ? 'Severe event: report to the national pharmacovigilance system (e.g. FDA MedWatch / Yellow Card).' : 'Document the reaction in the allergy/intolerance record.',
  ];

  // Dechallenge: continue vs stop the top PK-modelled suspect at onset.
  let dechallenge: CausalityResult['dechallenge'] = null;
  const suspect = candidates.find((c) => c.drugId && atOnset[c.drugId] !== undefined && c.category !== 'unlikely');
  if (suspect?.drugId) {
    const d = getDrug(suspect.drugId);
    const m = meds.find((x) => x.drugId === suspect.drugId)!;
    const horizon = Math.min(24 * 21, Math.max(48, 10 * ((0.693 * (d.pk.Vc + (d.pk.Vp ?? 0)) * 70) / Math.max(d.pk.CL || 1, 1e-6))));
    const others = courses.filter((c) => c.drugId !== suspect.drugId);
    const origin = new Date(Math.max(Math.min(...courses.map((c) => new Date(c.start).getTime())), onset - 300 * DAY));
    const startState = simulate({
      patient,
      physiology: phys,
      regimens: windowRegimens({ ...patient, medicationHistory: courses }, origin, new Date(event.onset)),
      durationH: Math.max(1, (onset - origin.getTime()) / 3600000),
      metricsOnly: true,
    }).finalState;
    const future = (includeSuspect: boolean) =>
      simulate({
        patient,
        physiology: phys,
        initial: startState,
        durationH: horizon,
        regimens: [
          ...(includeSuspect ? [{ id: 'c', drugId: suspect.drugId!, dose: m.dose!, unit: d.defaultRegimen.unit, intervalH: m.intervalH!, route: d.defaultRegimen.route, infusionH: d.defaultRegimen.infusionH, startH: m.intervalH! * 0.5, doses: Math.ceil(horizon / m.intervalH!) }] : []),
          ...others.map((c) => ({ id: c.id, drugId: c.drugId, dose: c.dose, unit: c.unit, intervalH: c.intervalH, route: c.route, infusionH: c.infusionH, startH: 0, doses: Math.ceil(horizon / c.intervalH) })),
        ],
      });
    const cont = future(true);
    const stop = future(false);
    const tox = d.toxic ? exposureToConc(d, d.toxic.value, d.toxic.basis) * d.display.factor : null;
    const s = stop.series[suspect.drugId]?.conc ?? [];
    let below: number | null = null;
    if (tox !== null) {
      const k = s.findIndex((v) => v < tox * 0.5);
      below = k >= 0 ? stop.t[k] : null;
    }
    const interp = (t: number[], y: number[], grid: number[]) => grid.map((g) => {
      let i = 0;
      while (i < t.length - 1 && t[i + 1] < g) i++;
      return y[i] ?? 0;
    });
    const grid = Array.from({ length: 150 }, (_, i) => (horizon * i) / 149);
    dechallenge = {
      drugId: suspect.drugId,
      t: grid,
      continued: interp(cont.t, cont.series[suspect.drugId]?.conc ?? [], grid),
      stopped: interp(stop.t, s, grid),
      unit: d.display.unit,
      threshold: tox,
      hoursToBelowThreshold: below,
    };
  }
  return { event, candidates, otherCauses: otherCauses / total, management, dechallenge };
}
