import { defaultPatient } from './physiology.js';
import type { Patient, Regimen } from './types.js';

export interface CaseQuestion {
  id: string;
  prompt: string;
  options: string[];
  answer: number;
  explanation: string;
}

export interface TrainingCase {
  id: string;
  title: string;
  specialty: string;
  difficulty: 'Foundation' | 'Intermediate' | 'Advanced';
  minutes: number;
  vignette: string;
  learningObjectives: string[];
  patient: Patient;
  regimens: Omit<Regimen, 'id'>[];
  questions: CaseQuestion[];
}

const reg = (drugId: string, dose: number, intervalH: number, doses: number, extra: Partial<Regimen> = {}): Omit<Regimen, 'id'> => ({
  drugId, dose, unit: 'mg', intervalH, route: 'po', startH: 0, doses, ...extra,
});

export const TRAINING_CASES: TrainingCase[] = [
  {
    id: 'vanco-aki',
    title: 'Vancomycin in evolving acute kidney injury',
    specialty: 'Infectious disease',
    difficulty: 'Intermediate',
    minutes: 8,
    vignette:
      'A 72-year-old man (82 kg, 170 cm) with MRSA bacteraemia receives vancomycin 1500 mg q12h. On day 3 his creatinine has risen from 1.0 to 2.1 mg/dL.',
    learningObjectives: ['Relate vancomycin clearance to CrCl', 'Apply AUC-guided dosing (ASHP 2020)', 'Recognise accumulation in AKI'],
    patient: defaultPatient({ name: 'Case: Mr V', age: 72, weightKg: 82, heightCm: 170, scr: 2.1 }),
    regimens: [reg('vancomycin', 1500, 12, 8, { route: 'iv_infusion', infusionH: 1.5 })],
    questions: [
      {
        id: 'q1', prompt: 'What happens to vancomycin AUC₂₄ when CrCl halves and the dose is unchanged?',
        options: ['It stays the same', 'It roughly doubles', 'It halves', 'It increases by 10%'], answer: 1,
        explanation: 'Vancomycin is ~95% renally cleared; CL ≈ CrCl, so AUC = Dose/CL roughly doubles. Run the simulation to see AUC exceed 600 mg·h/L.',
      },
      {
        id: 'q2', prompt: 'Which monitoring strategy is recommended by the 2020 consensus guideline for serious MRSA infection?',
        options: ['Trough 15–20 mg/L only', 'AUC₂₄ 400–600 mg·h/L, ideally Bayesian', 'Peak 40 mg/L', 'No monitoring needed'], answer: 1,
        explanation: 'ASHP/IDSA 2020 recommend AUC-guided dosing (400–600 mg·h/L), preferably Bayesian with 1–2 levels.',
      },
      {
        id: 'q3', prompt: 'The best immediate action is to…',
        options: ['Continue the same dose', 'Hold the next dose, check a level and re-dose by Bayesian estimate', 'Add gentamicin', 'Double the dose'], answer: 1,
        explanation: 'With rising creatinine, hold, measure, and re-estimate clearance; avoid additional nephrotoxins.',
      },
    ],
  },
  {
    id: 'codeine-um',
    title: 'Post-tonsillectomy analgesia in an ultrarapid metaboliser',
    specialty: 'Pharmacogenomics',
    difficulty: 'Foundation',
    minutes: 5,
    vignette: 'A 34-year-old woman with CYP2D6 ultrarapid metaboliser status is prescribed codeine 60 mg q6h after tonsillectomy.',
    learningObjectives: ['Understand prodrug activation by CYP2D6', 'Apply CPIC opioid recommendations'],
    patient: defaultPatient({ name: 'Case: Ms C', age: 34, sex: 'female', weightKg: 62, heightCm: 165, scr: 0.7, phenotypes: { CYP2D6: 'UM', CYP2C19: 'NM', CYP2C9: 'NM', CYP3A5: 'PM' } }),
    regimens: [reg('codeine', 60, 6, 12)],
    questions: [
      {
        id: 'q1', prompt: 'Why is codeine dangerous in this patient?',
        options: ['Reduced absorption', 'Excess conversion to morphine', 'Renal accumulation of codeine', 'QT prolongation'], answer: 1,
        explanation: 'CYP2D6 UM convert more codeine to morphine → opioid toxicity and respiratory depression.',
      },
      {
        id: 'q2', prompt: 'CPIC recommends:',
        options: ['Halve the codeine dose', 'Avoid codeine and tramadol; use a non-CYP2D6 opioid', 'Give with fluoxetine', 'Switch to oxycodone at double dose'], answer: 1,
        explanation: 'For UM and PM, CPIC advises avoiding codeine (and tramadol) and using alternatives such as morphine or non-opioids.',
      },
    ],
  },
  {
    id: 'warfarin-amio',
    title: 'Warfarin after starting amiodarone',
    specialty: 'Cardiology',
    difficulty: 'Intermediate',
    minutes: 7,
    vignette: 'A 68-year-old man stable on warfarin 5 mg daily (INR 2.5) starts amiodarone 200 mg daily for atrial fibrillation.',
    learningObjectives: ['Identify CYP2C9 inhibition', 'Anticipate delayed onset due to amiodarone kinetics', 'Plan INR monitoring'],
    patient: defaultPatient({ name: 'Case: Mr W', age: 68, weightKg: 80, heightCm: 176, scr: 1.1 }),
    regimens: [reg('warfarin', 5, 24, 42), reg('amiodarone', 200, 24, 42)],
    questions: [
      {
        id: 'q1', prompt: 'Mechanism of the interaction:',
        options: ['Induction of CYP3A4', 'Inhibition of CYP2C9 (S-warfarin clearance)', 'Protein-binding displacement only', 'Vitamin K antagonism'], answer: 1,
        explanation: 'Amiodarone and desethylamiodarone inhibit CYP2C9, reducing S-warfarin clearance.',
      },
      {
        id: 'q2', prompt: 'Why does the INR rise gradually over weeks?',
        options: ['Warfarin has a short half-life', 'Amiodarone accumulates slowly (t½ ~ 50–60 days)', 'INR is measured weekly', 'Absorption is delayed'], answer: 1,
        explanation: 'Amiodarone’s huge volume of distribution and long half-life mean inhibition builds over weeks.',
      },
      {
        id: 'q3', prompt: 'Recommended empirical warfarin adjustment:',
        options: ['No change', 'Reduce by 30–50% with weekly INR', 'Increase by 25%', 'Stop warfarin'], answer: 1,
        explanation: 'Reduce warfarin 30–50% and monitor INR weekly for at least 6–8 weeks.',
      },
    ],
  },
  {
    id: 'phenytoin-mm',
    title: 'Phenytoin non-linear kinetics',
    specialty: 'Neurology',
    difficulty: 'Advanced',
    minutes: 8,
    vignette: 'A 30-year-old man (70 kg) on phenytoin 300 mg/day has a steady-state level of 8 mg/L. The team increases to 400 mg/day.',
    learningObjectives: ['Apply Michaelis–Menten principles', 'Predict disproportionate concentration rise'],
    patient: defaultPatient({ name: 'Case: Mr P', age: 30 }),
    regimens: [reg('phenytoin', 100, 8, 63)],
    questions: [
      {
        id: 'q1', prompt: 'A 33% dose increase will raise the steady-state level by approximately:',
        options: ['33%', 'Less than 33%', 'Substantially more than 33% (often > 100%)', 'No change'], answer: 2,
        explanation: 'Saturable metabolism (Km ≈ 4 mg/L) means Css = Km·R/(Vmax−R); as R approaches Vmax the level rises steeply.',
      },
      {
        id: 'q2', prompt: 'How long until a new steady state is reached?',
        options: ['About 1 day', 'Always 5 half-lives of 22 h', 'Longer than expected — time to steady state increases with concentration', '2 hours'], answer: 2,
        explanation: 'With MM kinetics, the apparent half-life lengthens as concentration rises, so steady state takes longer (often 2–4 weeks).',
      },
    ],
  },
  {
    id: 'lithium-nsaid',
    title: 'Lithium toxicity after an NSAID',
    specialty: 'Psychiatry',
    difficulty: 'Foundation',
    minutes: 5,
    vignette: 'A 55-year-old woman on lithium 450 mg q12h (level 0.8 mmol/L) starts ibuprofen 400 mg q8h for back pain and develops tremor and confusion.',
    learningObjectives: ['Recognise renal-clearance interactions', 'Choose safer analgesia'],
    patient: defaultPatient({ name: 'Case: Ms L', age: 55, sex: 'female', weightKg: 68, heightCm: 163, scr: 0.9 }),
    regimens: [reg('lithium', 450, 12, 28), reg('ibuprofen', 400, 8, 42)],
    questions: [
      {
        id: 'q1', prompt: 'Mechanism:',
        options: ['CYP inhibition', 'Reduced renal prostaglandin-mediated lithium clearance', 'Increased absorption', 'Protein binding'], answer: 1,
        explanation: 'NSAIDs reduce renal blood flow and increase proximal lithium reabsorption, raising levels 25–40%.',
      },
      {
        id: 'q2', prompt: 'Preferred analgesic:',
        options: ['Naproxen', 'Acetaminophen', 'Diclofenac', 'Celecoxib'], answer: 1,
        explanation: 'Acetaminophen does not affect lithium clearance; all NSAIDs including COX-2 inhibitors can.',
      },
    ],
  },
  {
    id: 'tacro-cyp3a5',
    title: 'Tacrolimus in a CYP3A5 expresser',
    specialty: 'Transplant',
    difficulty: 'Advanced',
    minutes: 7,
    vignette: 'A 40-year-old kidney-transplant recipient (CYP3A5 *1/*1) has a tacrolimus trough of 3 ng/mL on 2 mg q12h. He is then started on fluconazole.',
    learningObjectives: ['Interpret CYP3A5 genotype', 'Predict azole interaction'],
    patient: defaultPatient({ name: 'Case: Mr T', age: 40, phenotypes: { CYP2D6: 'NM', CYP2C19: 'NM', CYP2C9: 'NM', CYP3A5: 'NM' }, procedures: [{ id: 'p1', type: 'kidney_tx', date: '2026-01-10' }] }),
    regimens: [reg('tacrolimus', 2, 12, 28)],
    questions: [
      {
        id: 'q1', prompt: 'Why is the trough low?',
        options: ['Non-adherence only', 'CYP3A5 expression increases tacrolimus clearance', 'Renal clearance is high', 'Rejection'], answer: 1,
        explanation: 'CYP3A5 expressers metabolise tacrolimus faster; CPIC recommends 1.5–2× starting dose.',
      },
      {
        id: 'q2', prompt: 'Adding fluconazole will:',
        options: ['Lower tacrolimus levels', 'Raise tacrolimus levels via CYP3A inhibition', 'Have no effect', 'Only affect kidney function'], answer: 1,
        explanation: 'Fluconazole is a moderate CYP3A4 inhibitor — expect ~2× rise; reduce dose and monitor trough.',
      },
    ],
  },
  {
    id: 'qt-stack',
    title: 'QT stacking in the emergency department',
    specialty: 'Emergency medicine',
    difficulty: 'Intermediate',
    minutes: 6,
    vignette: 'A 70-year-old woman on methadone 60 mg daily with K⁺ 3.2 mmol/L receives ondansetron and clarithromycin.',
    learningObjectives: ['Recognise additive QT risk', 'Identify modifiable risk factors'],
    patient: defaultPatient({ name: 'Case: Ms Q', age: 70, sex: 'female', weightKg: 60, heightCm: 160, scr: 1.0, potassium: 3.2 }),
    regimens: [reg('methadone', 60, 24, 7), reg('ondansetron', 8, 8, 21), reg('clarithromycin', 500, 12, 14)],
    questions: [
      {
        id: 'q1', prompt: 'Which factor is most readily modifiable?',
        options: ['Age', 'Female sex', 'Hypokalaemia', 'Methadone dependence'], answer: 2,
        explanation: 'Correct potassium (and magnesium) — hypokalaemia prolongs repolarisation and increases torsades risk.',
      },
      {
        id: 'q2', prompt: 'Clarithromycin also increases methadone exposure because it:',
        options: ['Induces CYP2B6', 'Inhibits CYP3A4', 'Increases absorption', 'Blocks renal excretion'], answer: 1,
        explanation: 'Strong CYP3A4 inhibition raises methadone levels, compounding the QT effect; prefer a non-macrolide.',
      },
    ],
  },
  {
    id: 'rifampin-induction',
    title: 'Rifampicin induction and its offset',
    specialty: 'Clinical pharmacology',
    difficulty: 'Advanced',
    minutes: 6,
    vignette: 'A patient on midazolam for procedural sedation completed a 2-week rifampicin course 3 days ago.',
    learningObjectives: ['Understand time course of enzyme induction', 'Use history to predict current physiology'],
    patient: defaultPatient({ name: 'Case: Induction' }),
    regimens: [reg('midazolam', 7.5, 24, 1)],
    questions: [
      {
        id: 'q1', prompt: 'Three days after stopping rifampicin, CYP3A4 activity is:',
        options: ['Back to baseline immediately', 'Still elevated, normalising over ~1–2 weeks', 'Inhibited', 'Permanently increased'], answer: 1,
        explanation: 'Induction reverses as excess enzyme is degraded (t½ ~ 1.5–3 days), so activity remains elevated for ~2 weeks. Add the course to the twin history to see carry-over.',
      },
    ],
  },
];

/** Score a training attempt server- or client-side. */
export function scoreCase(caseId: string, answers: Record<string, number>): { score: number; total: number; perQuestion: Record<string, boolean> } {
  const c = TRAINING_CASES.find((x) => x.id === caseId);
  if (!c) throw new Error('Unknown case');
  const perQuestion: Record<string, boolean> = {};
  let score = 0;
  for (const q of c.questions) {
    const ok = answers[q.id] === q.answer;
    perQuestion[q.id] = ok;
    if (ok) score++;
  }
  return { score, total: c.questions.length, perQuestion };
}
