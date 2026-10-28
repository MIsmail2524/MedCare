import { getDrug, registerDrug } from './drugs.js';
import { defaultPatient } from './physiology.js';
import { makeRegimen, simulate } from './pk.js';
import { DEFAULT_POPULATION, runTrial } from './population.js';
import type { PredictionResult } from './safety.js';
import { SAFETY_ORGANS } from './safety.js';
import type { Drug, Organ, Pathway, Patient, Regimen } from './types.js';

// "Regulatory twin": combines organ-liability priors (learned from FDA labels / FAERS for related
// drugs) with mechanistic exposure in virtual subpopulations to produce an exposure-stratified
// safety assessment, a draft label and the evidence gaps a reviewer would raise.

export interface CandidateSpec {
  name: string;
  classes: string[];
  smiles?: string;
  /** Human PK (70 kg adult): CL L/h, Vss L, oral F, ka 1/h, fraction renal, fraction unbound */
  CL: number;
  V: number;
  F: number;
  ka: number;
  fe: number;
  fu: number;
  metabolism: { pathway: Pathway; fm: number }[];
  dose: number;
  intervalH: number;
  route: 'po' | 'iv_infusion';
  /** Average steady-state target (mg/L) and provisional toxicity threshold (mg/L, e.g. NOAEL exposure / margin) */
  targetLow: number;
  targetHigh: number;
  toxicConc?: number;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'candidate';
}

/** Build a simulatable Drug from a candidate specification and predicted liabilities. */
export function candidateToDrug(spec: CandidateSpec, liab?: PredictionResult | null): Drug {
  const heartP = liab?.liabilities.find((l) => l.organ === 'heart')?.probability ?? 0;
  const organs = (liab?.liabilities ?? []).filter((l) => l.probability >= 0.3).map((l) => ({ organ: l.organ, kind: 'adverse' as const, note: `Predicted ${l.organ} liability (${Math.round(l.probability * 100)}%) from related drugs` }));
  const d: Drug = {
    id: `cand:${slug(spec.name)}`,
    name: spec.name,
    brands: [],
    drugClass: spec.classes[0] ?? 'Investigational',
    category: 'Investigational',
    mechanism: spec.classes.join('; ') || 'Investigational compound',
    indications: [],
    routes: [spec.route],
    defaultRegimen: { dose: spec.dose, unit: 'mg', intervalH: spec.intervalH, route: spec.route, infusionH: spec.route === 'iv_infusion' ? 1 : undefined },
    doseStep: Math.max(1, Number((spec.dose / 10).toPrecision(1))),
    pk: { F: spec.F, ka: spec.ka, CL: spec.CL, Vc: spec.V / 70, fe: spec.fe, fu: spec.fu, vScale: 'TBW', iiv: { CL: 0.35, V: 0.25, ka: 0.4 } },
    display: { unit: 'mg/L', factor: 1 },
    therapeutic: { low: spec.targetLow, high: spec.targetHigh, basis: 'average' },
    toxic: { value: spec.toxicConc ?? spec.targetHigh * 4, basis: 'peak', note: spec.toxicConc ? 'Provisional threshold from nonclinical exposure margin' : 'Provisional threshold (4× upper target) — no nonclinical data entered' },
    metabolism: spec.metabolism,
    inhibits: [],
    induces: [],
    qt: { risk: heartP >= 0.5 ? 'possible' : 'none', maxMs: Math.round(30 * heartP) },
    flags: [],
    organs,
    monitoring: [],
    references: [],
  };
  registerDrug(d);
  return d;
}

export interface Subgroup {
  id: string;
  label: string;
  patient: Patient;
  comedication?: string;
}

export function subgroupsFor(drug: Drug): Subgroup[] {
  const g: Subgroup[] = [
    { id: 'ref', label: 'Reference adult (40 y, 70 kg)', patient: defaultPatient() },
    { id: 'elderly', label: 'Older adult (82 y, SCr 1.3)', patient: defaultPatient({ age: 82, weightKg: 62, heightCm: 165, scr: 1.3 }) },
    { id: 'renal', label: 'Severe renal impairment (CrCl ≈ 25)', patient: defaultPatient({ age: 65, scr: 3.0 }) },
    { id: 'hepatic', label: 'Moderate hepatic impairment (Child–Pugh B)', patient: defaultPatient({ childPugh: 'B', albumin: 2.9 }) },
    { id: 'obese', label: 'Class III obesity (140 kg)', patient: defaultPatient({ weightKg: 140, heightCm: 172 }) },
    { id: 'small', label: 'Low body weight (48 kg female)', patient: defaultPatient({ sex: 'female', weightKg: 48, heightCm: 155, scr: 0.7 }) },
    { id: 'pregnant', label: 'Pregnancy (3rd trimester)', patient: defaultPatient({ sex: 'female', age: 30, weightKg: 75, heightCm: 165, scr: 0.55, pregnant: true }) },
  ];
  const main = drug.metabolism.slice().sort((a, b) => b.fm - a.fm)[0];
  if (main && (main.pathway === 'CYP2D6' || main.pathway === 'CYP2C19' || main.pathway === 'CYP2C9') && main.fm >= 0.25) {
    g.push({ id: 'pm', label: `${main.pathway} poor metaboliser`, patient: defaultPatient({ phenotypes: { CYP2D6: 'NM', CYP2C19: 'NM', CYP2C9: 'NM', CYP3A5: 'PM', [main.pathway]: 'PM' } as Patient['phenotypes'] }) });
  }
  if (drug.metabolism.some((m) => m.pathway === 'CYP3A4' && m.fm >= 0.2)) {
    g.push({ id: 'cyp3a_inh', label: '+ strong CYP3A4 inhibitor (clarithromycin)', patient: defaultPatient(), comedication: 'clarithromycin' });
    g.push({ id: 'cyp3a_ind', label: '+ strong inducer (rifampicin)', patient: defaultPatient(), comedication: 'rifampin' });
  }
  if (drug.metabolism.some((m) => m.pathway === 'CYP2D6' && m.fm >= 0.25)) g.push({ id: 'cyp2d6_inh', label: '+ strong CYP2D6 inhibitor (fluoxetine)', patient: defaultPatient(), comedication: 'fluoxetine' });
  if (drug.metabolism.some((m) => m.pathway === 'CYP1A2' && m.fm >= 0.25)) g.push({ id: 'cyp1a2_inh', label: '+ CYP1A2 inhibitor (ciprofloxacin)', patient: defaultPatient(), comedication: 'ciprofloxacin' });
  return g;
}

export interface SubgroupExposure {
  id: string;
  label: string;
  aucRatio: number;
  cmaxRatio: number;
  metric: number | null;
  status: string;
  toxic: boolean;
}

export interface OrganRisk {
  organ: Organ;
  probability: number;
  boxedLikely: boolean;
  rows: { id: string; index: number }[];
}

export interface DraftLabel {
  boxedWarning: string[];
  warnings: { organ: Organ; text: string }[];
  dosing: string[];
  interactions: string[];
  specificPopulations: string[];
  monitoring: string[];
}

export interface Dossier {
  drugId: string;
  name: string;
  regimen: Regimen;
  exposure: SubgroupExposure[];
  organRisk: OrganRisk[];
  label: DraftLabel;
  reviewerQuestions: string[];
  benefitRisk: { pta: number | null; pToxic: number | null; topRisks: { organ: Organ; probability: number }[]; summary: string };
}

const MONITORING: Record<Organ, string> = {
  liver: 'Liver tests (ALT, AST, bilirubin, ALP) at baseline and periodically; apply Hy’s-law stopping rules.',
  kidneys: 'Serum creatinine / eGFR and urine output at baseline and during treatment.',
  heart: 'ECG with QTc at baseline, at steady state and after dose increases; correct K⁺/Mg²⁺.',
  blood: 'Complete blood count with differential; signs of bleeding or infection.',
  skin: 'Counsel patients to stop and report any rash, blistering or mucosal lesions.',
  brain: 'Neurological and psychiatric assessment (sedation, seizures, mood, suicidality).',
  lungs: 'Respiratory rate, SpO₂; investigate new cough or dyspnoea (pneumonitis).',
  gi: 'GI symptoms and stool occult blood where bleeding risk is relevant.',
  pancreas: 'Glucose and lipase; abdominal pain evaluation.',
  muscle: 'CK if myalgia or weakness; tendon symptoms.',
  thyroid: 'TSH and free T4 at baseline and every 3–6 months.',
} as Record<Organ, string>;

const WARNING_TEXT: Record<Organ, string> = {
  liver: 'Hepatotoxicity: cases of liver injury may occur; monitor liver tests and discontinue for clinically significant elevations.',
  kidneys: 'Nephrotoxicity / acute kidney injury: avoid other nephrotoxins and volume depletion; monitor renal function.',
  heart: 'QT prolongation and cardiac arrhythmia: avoid with other QT-prolonging drugs and in congenital long-QT syndrome.',
  blood: 'Haematological toxicity / bleeding: monitor blood counts; increased bleeding risk with anticoagulants and antiplatelets.',
  skin: 'Serious cutaneous adverse reactions (SJS/TEN, DRESS): discontinue at first sign of rash.',
  brain: 'Central nervous system effects (sedation, seizures, neuropsychiatric events): caution in at-risk patients.',
  lungs: 'Respiratory toxicity (respiratory depression or interstitial lung disease).',
  gi: 'Gastrointestinal toxicity including ulceration, bleeding or severe diarrhoea.',
  pancreas: 'Pancreatitis and glycaemic disturbances.',
  muscle: 'Myopathy, rhabdomyolysis or tendon rupture.',
  thyroid: 'Thyroid dysfunction.',
} as Record<Organ, string>;

/** Exposure-stratified safety assessment and draft label for a drug (approved or candidate). */
export function buildDossier(drug: Drug, liab: PredictionResult | null, opts: { regimen?: Regimen; trialN?: number; days?: number } = {}): Dossier {
  const days = opts.days ?? 14;
  const base = opts.regimen ?? makeRegimen(drug.id, { doses: Math.max(1, Math.round((24 * days) / drug.defaultRegimen.intervalH)) });
  const groups = subgroupsFor(drug);
  const runFor = (g: Subgroup) => {
    const regs: Regimen[] = [base];
    if (g.comedication) regs.push(makeRegimen(g.comedication, { doses: Math.max(1, Math.round((24 * days) / getDrug(g.comedication).defaultRegimen.intervalH)) }));
    return simulate({ patient: g.patient, regimens: regs, durationH: base.startH + base.doses * base.intervalH, metricsOnly: true }).metrics[drug.id];
  };
  const ref = runFor(groups[0]);
  const exposure: SubgroupExposure[] = groups.map((g) => {
    const m = runFor(g);
    return {
      id: g.id,
      label: g.label,
      aucRatio: m.auc24 / Math.max(ref.auc24, 1e-12),
      cmaxRatio: m.cmax / Math.max(ref.cmax, 1e-12),
      metric: m.targetValue,
      status: m.toxicStatus === 'toxic' ? 'toxic' : m.targetStatus,
      toxic: m.toxicStatus === 'toxic',
    };
  });

  // Organ liabilities: predicted (or labelled) probability; exposure-scaled index per subgroup.
  const liabs = liab?.liabilities ?? SAFETY_ORGANS.map((o) => ({ organ: o, probability: drug.organs.some((x) => x.organ === o && x.kind === 'adverse') ? 0.4 : 0.05, boxedLikely: false, support: 0, evidence: [] }));
  const organRisk: OrganRisk[] = liabs.map((l) => ({
    organ: l.organ,
    probability: l.probability,
    boxedLikely: l.boxedLikely,
    rows: exposure.map((e) => ({ id: e.id, index: 1 - (1 - l.probability) ** Math.max(e.aucRatio, 0.05) ** 0.8 })),
  }));

  // Draft label
  const label: DraftLabel = { boxedWarning: [], warnings: [], dosing: [], interactions: [], specificPopulations: [], monitoring: [] };
  const SEVERE: Organ[] = ['liver', 'heart', 'blood', 'skin', 'lungs'];
  for (const r of organRisk) {
    if (r.probability >= 0.6 && (r.boxedLikely || SEVERE.includes(r.organ))) label.boxedWarning.push(WARNING_TEXT[r.organ]);
    if (r.probability >= 0.35) {
      label.warnings.push({ organ: r.organ, text: WARNING_TEXT[r.organ] });
      label.monitoring.push(MONITORING[r.organ]);
    }
  }
  const byId = Object.fromEntries(exposure.map((e) => [e.id, e]));
  const adj = (e: SubgroupExposure | undefined, what: string) => {
    if (!e) return;
    if (e.aucRatio >= 1.5) label.dosing.push(`${what}: exposure ↑ ${e.aucRatio.toFixed(1)}× — reduce dose by ≈ ${Math.round((1 - 1 / e.aucRatio) * 100)}% (or extend the interval) to match reference exposure.`);
    else if (e.aucRatio <= 0.67) label.dosing.push(`${what}: exposure ↓ to ${(e.aucRatio * 100).toFixed(0)}% — consider a ${Math.round((1 / e.aucRatio - 1) * 100)}% higher dose with monitoring.`);
  };
  adj(byId.renal, 'Severe renal impairment');
  adj(byId.hepatic, 'Moderate hepatic impairment');
  adj(byId.elderly, 'Older adults');
  adj(byId.pm, groups.find((g) => g.id === 'pm')?.label ?? 'Poor metabolisers');
  adj(byId.obese, 'Obesity');
  if (!label.dosing.length) label.dosing.push('No dose adjustment predicted for renal or hepatic impairment, age or body size within the simulated range.');
  for (const id of ['cyp3a_inh', 'cyp3a_ind', 'cyp2d6_inh', 'cyp1a2_inh']) {
    const e = byId[id];
    if (!e) continue;
    if (e.aucRatio >= 2) label.interactions.push(`${e.label.replace('+ ', '')}: AUC ↑ ${e.aucRatio.toFixed(1)}× — avoid co-administration or reduce dose by ${Math.round((1 - 1 / e.aucRatio) * 100)}%.`);
    else if (e.aucRatio >= 1.25) label.interactions.push(`${e.label.replace('+ ', '')}: AUC ↑ ${e.aucRatio.toFixed(1)}× — monitor for adverse reactions.`);
    else if (e.aucRatio <= 0.5) label.interactions.push(`${e.label.replace('+ ', '')}: AUC ↓ to ${(e.aucRatio * 100).toFixed(0)}% — avoid (loss of efficacy).`);
  }
  if (byId.pregnant) label.specificPopulations.push(`Pregnancy: simulated exposure ${(byId.pregnant.aucRatio * 100).toFixed(0)}% of reference (physiological changes only; no fetal-risk data).`);
  if (byId.pm && byId.pm.aucRatio >= 1.5) label.specificPopulations.push(`Pharmacogenomics: ${byId.pm.label} — ${byId.pm.aucRatio.toFixed(1)}× exposure; genotype-guided dosing should be considered.`);

  // Reviewer questions (evidence gaps)
  const rq: string[] = [];
  if (liab && !liab.applicability.inDomain) rq.push(`Structural novelty (max similarity ${liab.applicability.maxSimilarity.toFixed(2)}): safety predictions rely on base rates — request comprehensive nonclinical toxicology and in-vitro off-target panels.`);
  const heart = organRisk.find((r) => r.organ === 'heart');
  if (heart && heart.probability >= 0.3) rq.push('Cardiac liability predicted: request hERG IC₅₀, concentration–QTc analysis or thorough QT study (ICH E14/S7B) at supratherapeutic exposure.');
  const liver = organRisk.find((r) => r.organ === 'liver');
  if (liver && liver.probability >= 0.3) rq.push('Hepatic liability predicted: request DILI risk assessment (reactive-metabolite, BSEP inhibition, mitochondrial toxicity) and Hy’s-law case review.');
  if ((byId.cyp3a_inh?.aucRatio ?? 1) >= 2 || (byId.cyp2d6_inh?.aucRatio ?? 1) >= 2) rq.push('Major CYP-mediated victim interaction predicted: request clinical DDI study with a strong index inhibitor (ICH M12).');
  if ((byId.renal?.aucRatio ?? 1) >= 1.5) rq.push('Renal impairment markedly increases exposure: request a dedicated renal-impairment PK study.');
  if ((byId.hepatic?.aucRatio ?? 1) >= 1.5) rq.push('Hepatic impairment markedly increases exposure: request a hepatic-impairment PK study.');
  if (exposure.some((e) => e.toxic)) rq.push(`Simulated exposure exceeds the provisional toxicity threshold in: ${exposure.filter((e) => e.toxic).map((e) => e.label).join('; ')}.`);
  if (!rq.length) rq.push('No major evidence gaps identified by the twin at this dose — confirm with clinical data.');

  // Benefit–risk via virtual trial
  let pta: number | null = null;
  let pToxic: number | null = null;
  if (drug.therapeutic) {
    const arm = runTrial({ ...DEFAULT_POPULATION, n: opts.trialN ?? 120, seed: 11 }, [{ id: 'a', label: 'proposed', regimens: [base] }], drug.id)[0];
    pta = arm.pta;
    pToxic = arm.pToxic;
  }
  const topRisks = organRisk.slice(0, 3).map((r) => ({ organ: r.organ, probability: r.probability }));
  const summary =
    `${drug.name} ${base.dose} ${base.unit} q${base.intervalH}h: ` +
    (pta !== null ? `${Math.round(pta * 100)}% of a virtual population reach the target exposure; ${Math.round((pToxic ?? 0) * 100)}% exceed the toxicity threshold. ` : '') +
    `Leading predicted liabilities: ${topRisks.map((r) => `${r.organ} ${Math.round(r.probability * 100)}%`).join(', ')}. ` +
    `${label.dosing.length && !label.dosing[0].startsWith('No dose') ? 'Dose adjustment needed in specific populations.' : ''}`;

  return { drugId: drug.id, name: drug.name, regimen: base, exposure, organRisk, label, reviewerQuestions: rq, benefitRisk: { pta, pToxic, topRisks, summary } };
}
