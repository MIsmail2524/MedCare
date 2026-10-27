import { getDrug } from './drugs.js';
import { PHENOTYPE_LABEL } from './physiology.js';
import { RENAL_INTERACTIONS } from './pk.js';
import type { SimulationResult } from './pk.js';
import type { Alert, Drug, Patient, Physiology, RiskFlag } from './types.js';

const SEVERITY_RANK = { contraindicated: 3, major: 2, moderate: 1, info: 0 } as const;

const FLAG_RULES: { flag: RiskFlag; min: number; severity: Alert['severity']; title: string; detail: string; action: string }[] = [
  {
    flag: 'qt', min: 2, severity: 'major', title: 'Additive QT prolongation',
    detail: 'Two or more drugs with known QT/torsades risk are combined.',
    action: 'Obtain baseline and follow-up ECG; correct K⁺/Mg²⁺; prefer non-QT alternatives.',
  },
  {
    flag: 'serotonergic', min: 2, severity: 'moderate', title: 'Serotonin syndrome risk',
    detail: 'Multiple serotonergic agents increase the risk of serotonin toxicity.',
    action: 'Monitor for clonus, hyperthermia, agitation; avoid unnecessary combinations.',
  },
  {
    flag: 'cnsDepressant', min: 2, severity: 'major', title: 'Additive CNS / respiratory depression',
    detail: 'Opioids combined with benzodiazepines or other sedatives (FDA boxed warning).',
    action: 'Use lowest doses, continuous SpO₂/EtCO₂ monitoring, naloxone available.',
  },
  {
    flag: 'bleeding', min: 2, severity: 'major', title: 'Additive bleeding risk',
    detail: 'Combination of anticoagulant, antiplatelet, NSAID or SSRI effects on haemostasis.',
    action: 'Reassess indication for each agent; add gastroprotection; monitor haemoglobin.',
  },
  {
    flag: 'nephrotoxic', min: 2, severity: 'major', title: 'Combined nephrotoxicity',
    detail: 'Two or more nephrotoxic agents increase acute kidney injury risk.',
    action: 'Monitor creatinine every 24–48 h; maintain hydration; use AUC-guided dosing.',
  },
  {
    flag: 'hepatotoxic', min: 2, severity: 'moderate', title: 'Combined hepatotoxicity',
    detail: 'Two or more hepatotoxic drugs are co-prescribed.',
    action: 'Baseline and periodic LFTs.',
  },
  {
    flag: 'hyperkalemia', min: 2, severity: 'moderate', title: 'Hyperkalaemia risk',
    detail: 'Multiple agents raise serum potassium.',
    action: 'Check potassium within 1 week.',
  },
];

/** Curated, clinically important pairs beyond the mechanistic model. */
export const CURATED_PAIRS: { a: string; b: string; severity: Alert['severity']; title: string; detail: string; action: string }[] = [
  { a: 'warfarin', b: 'amiodarone', severity: 'major', title: 'Warfarin potentiation', detail: 'Amiodarone inhibits CYP2C9; INR rises over 2–6 weeks.', action: 'Reduce warfarin 30–50%; weekly INR for 6–8 weeks.' },
  { a: 'warfarin', b: 'fluconazole', severity: 'major', title: 'Warfarin potentiation', detail: 'Fluconazole inhibits CYP2C9 (S-warfarin).', action: 'Reduce warfarin dose and monitor INR closely.' },
  { a: 'warfarin', b: 'ibuprofen', severity: 'major', title: 'Bleeding risk', detail: 'NSAIDs impair platelet function and injure gastric mucosa.', action: 'Avoid; use acetaminophen for analgesia.' },
  { a: 'warfarin', b: 'rifampin', severity: 'major', title: 'Loss of anticoagulation', detail: 'Rifampicin induces CYP2C9/3A4; dose requirements can triple.', action: 'Avoid or monitor INR twice weekly; taper after stopping.' },
  { a: 'warfarin', b: 'ciprofloxacin', severity: 'moderate', title: 'INR elevation', detail: 'Reduced R-warfarin clearance and altered gut flora.', action: 'Monitor INR within 3–5 days.' },
  { a: 'digoxin', b: 'amiodarone', severity: 'major', title: 'Digoxin toxicity', detail: 'P-gp inhibition roughly doubles digoxin concentration.', action: 'Halve digoxin dose; check level in 1 week.' },
  { a: 'digoxin', b: 'clarithromycin', severity: 'major', title: 'Digoxin toxicity', detail: 'P-gp inhibition increases digoxin exposure.', action: 'Use azithromycin or reduce digoxin and monitor.' },
  { a: 'digoxin', b: 'furosemide', severity: 'moderate', title: 'Hypokalaemia-induced digoxin toxicity', detail: 'Loop diuretic K⁺ loss sensitises the myocardium.', action: 'Keep K⁺ ≥ 4.0 mmol/L.' },
  { a: 'atorvastatin', b: 'clarithromycin', severity: 'major', title: 'Myopathy / rhabdomyolysis', detail: 'Strong CYP3A4 inhibition raises atorvastatin exposure ~4–5×.', action: 'Limit atorvastatin to 20 mg or suspend during course.' },
  { a: 'clopidogrel', b: 'omeprazole', severity: 'major', title: 'Reduced antiplatelet effect', detail: 'Omeprazole inhibits CYP2C19 activation of clopidogrel.', action: 'Use pantoprazole instead.' },
  { a: 'codeine', b: 'fluoxetine', severity: 'moderate', title: 'Loss of analgesia', detail: 'Strong CYP2D6 inhibition blocks morphine formation (phenoconversion).', action: 'Choose a non-prodrug opioid.' },
  { a: 'theophylline', b: 'ciprofloxacin', severity: 'major', title: 'Theophylline toxicity', detail: 'CYP1A2 inhibition doubles theophylline levels; seizure risk.', action: 'Reduce theophylline 30–50% or use another antibiotic.' },
  { a: 'lithium', b: 'ibuprofen', severity: 'major', title: 'Lithium toxicity', detail: 'NSAIDs reduce renal lithium clearance.', action: 'Avoid; if necessary check level in 5 days.' },
  { a: 'lithium', b: 'lisinopril', severity: 'major', title: 'Lithium toxicity', detail: 'ACE inhibitors increase lithium reabsorption (levels ↑ 35%).', action: 'Reduce lithium dose; monitor levels and renal function.' },
  { a: 'methotrexate', b: 'ibuprofen', severity: 'major', title: 'Methotrexate toxicity', detail: 'Reduced renal secretion of methotrexate.', action: 'Avoid NSAIDs around methotrexate dosing.' },
  { a: 'lisinopril', b: 'ibuprofen', severity: 'moderate', title: 'AKI / reduced antihypertensive effect', detail: 'NSAIDs counteract ACE inhibitor and impair renal autoregulation ("triple whammy" with diuretics).', action: 'Avoid in CKD; monitor creatinine.' },
  { a: 'tacrolimus', b: 'clarithromycin', severity: 'major', title: 'Tacrolimus toxicity', detail: 'Strong CYP3A4 inhibition — nephro- and neurotoxicity.', action: 'Avoid or reduce tacrolimus and monitor trough daily.' },
  { a: 'tacrolimus', b: 'fluconazole', severity: 'major', title: 'Tacrolimus exposure ↑', detail: 'CYP3A4 inhibition doubles tacrolimus levels.', action: 'Reduce tacrolimus ~50%; monitor trough.' },
  { a: 'tacrolimus', b: 'rifampin', severity: 'contraindicated', title: 'Graft rejection risk', detail: 'Induction reduces tacrolimus exposure by 70–90%.', action: 'Avoid; use rifabutin with intensive TDM.' },
  { a: 'lamotrigine', b: 'valproate', severity: 'major', title: 'Lamotrigine accumulation / SJS', detail: 'UGT inhibition doubles lamotrigine half-life.', action: 'Halve lamotrigine dose and titrate slowly.' },
  { a: 'methadone', b: 'rifampin', severity: 'major', title: 'Opioid withdrawal', detail: 'Induction of CYP3A4/2B6 lowers methadone levels.', action: 'Increase methadone with monitoring.' },
  { a: 'midazolam', b: 'clarithromycin', severity: 'major', title: 'Prolonged sedation', detail: 'Strong CYP3A4 inhibition.', action: 'Avoid oral midazolam; reduce IV dose.' },
  { a: 'metformin', b: 'lisinopril', severity: 'info', title: 'Monitor renal function', detail: 'ACE inhibitor may reduce GFR initially in volume-depleted patients.', action: 'Check eGFR after initiation.' },
];

export function hasPair(ids: string[], a: string, b: string): boolean {
  return ids.includes(a) && ids.includes(b);
}

/** Generate clinical decision-support alerts for a regimen set in a specific patient. */
export function evaluateAlerts(patient: Patient, phys: Physiology, drugIds: string[], sim?: SimulationResult): Alert[] {
  const alerts: Alert[] = [];
  const drugs = drugIds.map(getDrug);
  const names = (ds: Drug[]) => ds.map((d) => d.id);

  // Curated pairs
  for (const p of CURATED_PAIRS) {
    if (hasPair(drugIds, p.a, p.b)) {
      alerts.push({ severity: p.severity, title: p.title, detail: p.detail, action: p.action, drugs: [p.a, p.b], category: 'interaction' });
    }
  }

  // Mechanistic pathway interactions not curated
  for (const victim of drugs) {
    for (const perp of drugs) {
      if (victim.id === perp.id) continue;
      if (CURATED_PAIRS.some((c) => (c.a === victim.id && c.b === perp.id) || (c.b === victim.id && c.a === perp.id))) continue;
      for (const m of victim.metabolism) {
        const inh = perp.inhibits.find((x) => x.pathway === m.pathway);
        const ind = perp.induces.find((x) => x.pathway === m.pathway);
        if (inh && m.fm >= 0.3 && inh.strength !== 'weak') {
          alerts.push({
            severity: inh.strength === 'strong' && m.fm >= 0.7 ? 'major' : 'moderate',
            title: `${perp.name} inhibits ${m.pathway}`,
            detail: `${victim.name} is ${(m.fm * 100).toFixed(0)}% cleared by ${m.pathway}; ${inh.strength} inhibition increases exposure.`,
            action: 'Review dose; see simulated exposure change.',
            drugs: [victim.id, perp.id],
            category: 'interaction',
          });
        }
        if (ind && m.fm >= 0.3) {
          alerts.push({
            severity: ind.strength === 'strong' ? 'major' : 'moderate',
            title: `${perp.name} induces ${m.pathway}`,
            detail: `${victim.name} exposure will fall over 1–2 weeks as enzyme induction develops (and recover over ~2 weeks after stopping).`,
            action: 'Consider alternative or titrate with monitoring.',
            drugs: [victim.id, perp.id],
            category: 'interaction',
          });
        }
      }
      const pd = victim.prodrug;
      if (pd) {
        const inh = perp.inhibits.find((x) => x.pathway === pd.pathway);
        if (inh && !CURATED_PAIRS.some((c) => hasPair([victim.id, perp.id], c.a, c.b))) {
          alerts.push({
            severity: 'major', title: 'Prodrug activation blocked',
            detail: `${perp.name} inhibits ${pd.pathway}, reducing formation of ${pd.activeMoiety}.`,
            action: 'Choose a non-prodrug alternative.', drugs: [victim.id, perp.id], category: 'interaction',
          });
        }
      }
    }
  }
  for (const ri of RENAL_INTERACTIONS) {
    if (hasPair(drugIds, ri.victim, ri.perpetrator) && !CURATED_PAIRS.some((c) => hasPair([ri.victim, ri.perpetrator], c.a, c.b))) {
      alerts.push({ severity: 'moderate', title: 'Renal clearance interaction', detail: ri.note, drugs: [ri.victim, ri.perpetrator], category: 'interaction' });
    }
  }

  // Class-flag combinations
  for (const rule of FLAG_RULES) {
    const hits = drugs.filter((d) => d.flags.includes(rule.flag));
    if (rule.flag === 'qt') {
      const known = drugs.filter((d) => d.qt.risk === 'known');
      if (known.length >= rule.min) alerts.push({ severity: rule.severity, title: rule.title, detail: rule.detail, action: rule.action, drugs: names(known), category: 'qt' });
      continue;
    }
    if (rule.flag === 'cnsDepressant') {
      const opioid = hits.filter((d) => d.drugClass.toLowerCase().includes('opioid'));
      if (hits.length >= 2 && opioid.length >= 1) alerts.push({ severity: rule.severity, title: rule.title, detail: rule.detail, action: rule.action, drugs: names(hits), category: 'interaction' });
      continue;
    }
    if (hits.length >= rule.min) alerts.push({ severity: rule.severity, title: rule.title, detail: rule.detail, action: rule.action, drugs: names(hits), category: 'interaction' });
  }
  if (hasPair(drugIds, 'lisinopril', 'ibuprofen') && drugIds.includes('furosemide')) {
    alerts.push({
      severity: 'major', title: '"Triple whammy" — AKI risk',
      detail: 'ACE inhibitor + NSAID + diuretic markedly increases acute kidney injury risk.',
      action: 'Stop the NSAID.', drugs: ['lisinopril', 'ibuprofen', 'furosemide'], category: 'renal',
    });
  }

  // Patient-specific checks
  for (const d of drugs) {
    // Pharmacogenomics
    if (d.id === 'codeine' && (patient.phenotypes.CYP2D6 === 'UM' || patient.phenotypes.CYP2D6 === 'PM')) {
      alerts.push({
        severity: patient.phenotypes.CYP2D6 === 'UM' ? 'contraindicated' : 'major',
        title: `Codeine in CYP2D6 ${PHENOTYPE_LABEL[patient.phenotypes.CYP2D6]}`,
        detail: patient.phenotypes.CYP2D6 === 'UM' ? 'Excess morphine formation — life-threatening respiratory depression.' : 'Insufficient morphine formation — analgesic failure.',
        action: 'Avoid codeine and tramadol; use a non-CYP2D6 opioid (CPIC).', drugs: [d.id], category: 'pgx',
      });
    }
    if (d.id === 'clopidogrel' && (patient.phenotypes.CYP2C19 === 'PM' || patient.phenotypes.CYP2C19 === 'IM')) {
      alerts.push({
        severity: 'major', title: `Clopidogrel in CYP2C19 ${PHENOTYPE_LABEL[patient.phenotypes.CYP2C19]}`,
        detail: 'Reduced active-metabolite formation; higher rate of stent thrombosis and MACE.',
        action: 'Use prasugrel or ticagrelor if no contraindication (CPIC 2022).', drugs: [d.id], category: 'pgx',
      });
    }
    if (d.id === 'citalopram' && patient.phenotypes.CYP2C19 === 'PM') {
      alerts.push({ severity: 'moderate', title: 'Citalopram in CYP2C19 PM', detail: 'Exposure ~2× — QT risk above 20 mg/day.', action: 'Maximum 20 mg/day.', drugs: [d.id], category: 'pgx' });
    }
    if (d.id === 'warfarin' && (patient.phenotypes.CYP2C9 !== 'NM' || patient.vkorc1 !== 'GG')) {
      alerts.push({
        severity: 'moderate', title: 'Warfarin pharmacogenomic sensitivity',
        detail: `CYP2C9 ${patient.phenotypes.CYP2C9}, VKORC1 ${patient.vkorc1}: lower dose requirement, longer time to stable INR.`,
        action: 'Use a genotype-guided dosing algorithm (IWPC / CPIC).', drugs: [d.id], category: 'pgx',
      });
    }
    if (d.id === 'tacrolimus' && patient.phenotypes.CYP3A5 !== 'PM') {
      alerts.push({ severity: 'moderate', title: 'CYP3A5 expresser', detail: 'Higher tacrolimus clearance — subtherapeutic troughs at standard doses.', action: 'Start at 1.5–2× standard dose (max 0.3 mg/kg/day) with TDM.', drugs: [d.id], category: 'pgx' });
    }
    if ((d.id === 'carbamazepine' || d.id === 'phenytoin') && patient.hla.B1502) {
      alerts.push({ severity: 'contraindicated', title: 'HLA-B*15:02 positive', detail: 'High risk of SJS/TEN.', action: 'Avoid carbamazepine/phenytoin (CPIC).', drugs: [d.id], category: 'pgx' });
    }
    if (d.id === 'metoprolol' && patient.phenotypes.CYP2D6 === 'PM') {
      alerts.push({ severity: 'moderate', title: 'Metoprolol in CYP2D6 PM', detail: '4–5× exposure: bradycardia risk.', action: 'Lower dose or use bisoprolol.', drugs: [d.id], category: 'pgx' });
    }
    if (d.id === 'ondansetron' && patient.phenotypes.CYP2D6 === 'UM') {
      alerts.push({ severity: 'moderate', title: 'Ondansetron in CYP2D6 UM', detail: 'Reduced antiemetic response.', action: 'Use granisetron.', drugs: [d.id], category: 'pgx' });
    }
    if (d.id === 'omeprazole' && (patient.phenotypes.CYP2C19 === 'UM' || patient.phenotypes.CYP2C19 === 'RM')) {
      alerts.push({ severity: 'info', title: 'PPI in CYP2C19 rapid/ultrarapid', detail: 'Lower omeprazole exposure — possible treatment failure.', action: 'Increase dose 100% (CPIC).', drugs: [d.id], category: 'pgx' });
    }

    // Renal
    if (d.pk.fe >= 0.5 && phys.crcl < 50) {
      alerts.push({
        severity: phys.crcl < 30 ? 'major' : 'moderate',
        title: `${d.name}: renal dose adjustment`,
        detail: `${(d.pk.fe * 100).toFixed(0)}% renally eliminated; CrCl ${phys.crcl.toFixed(0)} mL/min. ${d.renal ?? ''}`.trim(),
        action: 'Adjust dose/interval; consider TDM.', drugs: [d.id], category: 'renal',
      });
    }
    if (d.id === 'metformin' && phys.egfr < 30) {
      alerts.push({ severity: 'contraindicated', title: 'Metformin contraindicated', detail: `eGFR ${phys.egfr.toFixed(0)} < 30 mL/min/1.73 m²: lactic acidosis risk.`, action: 'Stop metformin.', drugs: [d.id], category: 'renal' });
    }
    if (d.id === 'morphine' && phys.crcl < 30) {
      alerts.push({ severity: 'major', title: 'Morphine metabolite accumulation', detail: 'M6G/M3G accumulate in renal failure → sedation, myoclonus.', action: 'Use hydromorphone/fentanyl at reduced dose.', drugs: [d.id], category: 'renal' });
    }
    if (d.flags.includes('nephrotoxic') && phys.crcl < 60) {
      alerts.push({ severity: 'moderate', title: `${d.name} in reduced renal function`, detail: 'Nephrotoxin in a patient with reduced renal reserve.', action: 'Monitor creatinine closely.', drugs: [d.id], category: 'renal' });
    }
    // Hepatic
    if (patient.childPugh !== 'none' && (d.flags.includes('hepatotoxic') || d.pk.fe < 0.3)) {
      alerts.push({
        severity: patient.childPugh === 'C' ? 'major' : 'moderate',
        title: `${d.name} in Child–Pugh ${patient.childPugh}`,
        detail: `${d.hepatic ?? 'Hepatically cleared — reduced clearance expected.'}`,
        action: 'Reduce dose; monitor for toxicity.', drugs: [d.id], category: 'hepatic',
      });
    }
    if (d.id === 'acetaminophen' && (patient.alcoholUse === 'heavy' || patient.childPugh !== 'none')) {
      alerts.push({ severity: 'moderate', title: 'Acetaminophen hepatotoxicity risk factor', detail: 'Chronic alcohol use or liver disease lowers the toxic threshold.', action: 'Limit to 2 g/day.', drugs: [d.id], category: 'hepatic' });
    }
    if (d.id === 'phenytoin' && patient.albumin < 3.5) {
      alerts.push({
        severity: 'moderate', title: 'Interpret phenytoin with albumin correction',
        detail: `Sheiner–Tozer: corrected = measured / (0.2 × ${patient.albumin} + 0.1) = measured × ${(1 / (0.2 * patient.albumin + 0.1)).toFixed(2)}.`,
        action: 'Measure free phenytoin where available.', drugs: [d.id], category: 'exposure',
      });
    }
    if (d.id === 'digoxin' && patient.potassium < 3.5) {
      alerts.push({ severity: 'major', title: 'Hypokalaemia with digoxin', detail: `K⁺ ${patient.potassium} mmol/L sensitises to digoxin toxicity.`, action: 'Correct potassium to ≥ 4.0.', drugs: [d.id], category: 'exposure' });
    }
    // Pregnancy
    if (patient.pregnant && d.pregnancy) {
      alerts.push({ severity: /contraindicated|avoid|teratogen/i.test(d.pregnancy) ? 'major' : 'moderate', title: `${d.name} in pregnancy`, detail: d.pregnancy, drugs: [d.id], category: 'pregnancy' });
    }
    // Allergy (simple class/name match)
    for (const a of patient.allergies) {
      const al = a.toLowerCase().trim();
      if (al && (d.name.toLowerCase().includes(al) || d.drugClass.toLowerCase().includes(al) || d.brands.some((b) => b.toLowerCase().includes(al)))) {
        alerts.push({ severity: 'contraindicated', title: `Documented allergy: ${a}`, detail: `${d.name} matches a recorded allergy.`, action: 'Do not administer; choose another class.', drugs: [d.id], category: 'allergy' });
      }
    }
    if (patient.age >= 65 && (d.flags.includes('cnsDepressant') || d.id === 'haloperidol')) {
      alerts.push({ severity: 'info', title: `Beers criteria: ${d.name}`, detail: 'Older adults: increased risk of falls, delirium and respiratory depression.', action: 'Start low, go slow.', drugs: [d.id], category: 'exposure' });
    }
  }

  // Simulation-derived exposure alerts
  if (sim) {
    for (const id of drugIds) {
      const m = sim.metrics[id];
      const d = getDrug(id);
      if (!m) continue;
      if (m.toxicStatus === 'toxic' && d.toxic) {
        alerts.push({ severity: 'major', title: `${d.name}: predicted toxic exposure`, detail: `${d.toxic.note}. Predicted ${d.toxic.basis} exceeds ${d.toxic.value} ${d.toxic.basis === 'auc24' ? 'mg·h/L' : d.display.unit}.`, action: 'Reduce dose or extend interval.', drugs: [id], category: 'exposure' });
      } else if (m.targetStatus === 'below' && d.therapeutic) {
        alerts.push({ severity: 'moderate', title: `${d.name}: sub-therapeutic`, detail: `Predicted ${d.therapeutic.basis} ${fmt(m.targetValue!)} below target ${d.therapeutic.low}–${d.therapeutic.high}.`, action: 'See dose recommendation.', drugs: [id], category: 'exposure' });
      } else if (m.targetStatus === 'above' && d.therapeutic) {
        alerts.push({ severity: 'moderate', title: `${d.name}: above target range`, detail: `Predicted ${d.therapeutic.basis} ${fmt(m.targetValue!)} above target ${d.therapeutic.low}–${d.therapeutic.high}.`, action: 'See dose recommendation.', drugs: [id], category: 'exposure' });
      }
    }
    const qmax = Math.max(...sim.qtc, 0);
    if (qmax >= 500 || qmax - sim.physiology.baselineQTc >= 60) {
      alerts.push({ severity: 'major', title: 'Predicted QTc ≥ 500 ms or Δ ≥ 60 ms', detail: `Peak predicted QTc ${qmax.toFixed(0)} ms (baseline ${sim.physiology.baselineQTc}).`, action: 'High torsades risk: modify regimen, monitor ECG.', drugs: drugIds.filter((i) => getDrug(i).qt.maxMs > 0), category: 'qt' });
    } else if (qmax >= 470) {
      alerts.push({ severity: 'moderate', title: 'Predicted QTc prolongation', detail: `Peak predicted QTc ${qmax.toFixed(0)} ms.`, action: 'ECG monitoring.', drugs: drugIds.filter((i) => getDrug(i).qt.maxMs > 0), category: 'qt' });
    }
  }

  // De-duplicate by title + drugs
  const seen = new Set<string>();
  return alerts
    .filter((a) => {
      const k = a.title + a.drugs.slice().sort().join();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

function fmt(v: number): string {
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toPrecision(2);
}
