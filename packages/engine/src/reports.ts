import { DRUGS } from './drugs.js';
import type { MedicationCourse, Patient, Phenotype } from './types.js';

// Turn patient reports (free-text lab reports, CSV exports, FHIR R4 bundles) into digital-twin
// parameters. Everything runs locally; nothing here sends data anywhere.

export interface Finding {
  field: string;
  label: string;
  value: string | number;
  unit?: string;
  source: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ReportExtraction {
  findings: Finding[];
  patch: Partial<Patient>;
  medications: MedicationCourse[];
  childPughScore: number | null;
  warnings: string[];
}

const num = (s: string) => Number(s.replace(',', '.'));

interface LabRule {
  field: string;
  label: string;
  re: RegExp;
  convert?: (v: number, unit: string) => { value: number; unit: string } | null;
}

const LAB_RULES: LabRule[] = [
  {
    field: 'scr', label: 'Serum creatinine',
    re: /(?:serum\s+)?creatinine[^\d\n]{0,25}?(\d+(?:[.,]\d+)?)\s*(mg\/dl|µmol\/l|umol\/l|μmol\/l)?/i,
    convert: (v, u) => (/mol/i.test(u) || v > 20 ? { value: Math.round((v / 88.4) * 100) / 100, unit: 'mg/dL' } : { value: v, unit: 'mg/dL' }),
  },
  {
    field: 'albumin', label: 'Albumin',
    re: /albumin[^\d\n]{0,20}?(\d+(?:[.,]\d+)?)\s*(g\/dl|g\/l)?/i,
    convert: (v, u) => (/g\/l/i.test(u) || v > 10 ? { value: Math.round(v) / 10, unit: 'g/dL' } : { value: v, unit: 'g/dL' }),
  },
  { field: 'potassium', label: 'Potassium', re: /(?:potassium|\bk\+?)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(mmol\/l|meq\/l)?/i },
  { field: 'alt', label: 'ALT', re: /\b(?:alt|sgpt|alanine aminotransferase)\b[^\d\n]{0,15}?(\d+(?:[.,]\d+)?)\s*(u\/l|iu\/l)?/i },
  { field: 'ast', label: 'AST', re: /\b(?:ast|sgot|aspartate aminotransferase)\b[^\d\n]{0,15}?(\d+(?:[.,]\d+)?)\s*(u\/l|iu\/l)?/i },
  {
    field: 'bilirubin', label: 'Total bilirubin',
    re: /(?:total\s+)?bilirubin[^\d\n]{0,20}?(\d+(?:[.,]\d+)?)\s*(mg\/dl|µmol\/l|umol\/l|μmol\/l)?/i,
    convert: (v, u) => (/mol/i.test(u) || v > 15 ? { value: Math.round((v / 17.1) * 100) / 100, unit: 'mg/dL' } : { value: v, unit: 'mg/dL' }),
  },
  { field: 'inr', label: 'INR', re: /\binr\b[^\d\n]{0,10}?(\d+(?:[.,]\d+)?)/i },
  { field: 'egfr', label: 'eGFR', re: /\begfr\b[^\d\n]{0,20}?(\d+(?:[.,]\d+)?)/i },
  { field: 'qtc', label: 'QTc', re: /\bqtc\b[^\d\n]{0,10}?(\d{3})\s*(ms)?/i },
  { field: 'hr', label: 'Heart rate', re: /(?:heart rate|pulse|\bhr\b)[^\d\n]{0,10}?(\d{2,3})\s*(bpm|\/min)?/i },
  { field: 'sbp', label: 'Systolic BP', re: /(?:blood pressure|\bbp\b)[^\d\n]{0,10}?(\d{2,3})\s*\/\s*\d{2,3}/i },
  {
    field: 'weightKg', label: 'Weight',
    re: /weight[^\d\n]{0,10}?(\d+(?:[.,]\d+)?)\s*(kg|lb|lbs)?/i,
    convert: (v, u) => (/lb/i.test(u) ? { value: Math.round(v * 0.4536 * 10) / 10, unit: 'kg' } : { value: v, unit: 'kg' }),
  },
  {
    field: 'heightCm', label: 'Height',
    re: /height[^\d\n]{0,10}?(\d+(?:[.,]\d+)?)\s*(cm|m|in)?\b/i,
    convert: (v, u) => (/^m$/i.test(u) || v < 3 ? { value: Math.round(v * 100), unit: 'cm' } : /in/i.test(u) ? { value: Math.round(v * 2.54), unit: 'cm' } : { value: v, unit: 'cm' }),
  },
  { field: 'age', label: 'Age', re: /\bage\b[^\d\n]{0,8}?(\d{1,3})\s*(y|yr|years)?/i },
];

const PHENO_WORDS: [RegExp, Phenotype][] = [
  [/ultra[- ]?rapid/i, 'UM'],
  [/rapid/i, 'RM'],
  [/poor/i, 'PM'],
  [/intermediate/i, 'IM'],
  [/normal|extensive/i, 'NM'],
];

// Simplified CPIC star-allele activity scores for diplotype → phenotype.
const CYP2D6_ACT: Record<string, number> = { '1': 1, '2': 1, '35': 1, '9': 0.5, '10': 0.25, '17': 0.5, '29': 0.5, '41': 0.5, '3': 0, '4': 0, '5': 0, '6': 0, '1xN': 2, '2xN': 2 };
const CYP2C19_FUNC: Record<string, 'normal' | 'no' | 'increased'> = { '1': 'normal', '2': 'no', '3': 'no', '17': 'increased' };
const CYP2C9_ACT: Record<string, number> = { '1': 1, '2': 0.5, '3': 0, '5': 0.5, '8': 0.5, '11': 0.5 };

export function diplotypeToPhenotype(gene: 'CYP2D6' | 'CYP2C19' | 'CYP2C9' | 'CYP3A5', a: string, b: string): Phenotype | null {
  if (gene === 'CYP2D6') {
    const s = (CYP2D6_ACT[a] ?? NaN) + (CYP2D6_ACT[b] ?? NaN);
    if (!Number.isFinite(s)) return null;
    return s === 0 ? 'PM' : s < 1.25 ? 'IM' : s <= 2.25 ? 'NM' : 'UM';
  }
  if (gene === 'CYP2C19') {
    const fa = CYP2C19_FUNC[a];
    const fb = CYP2C19_FUNC[b];
    if (!fa || !fb) return null;
    const no = [fa, fb].filter((f) => f === 'no').length;
    const inc = [fa, fb].filter((f) => f === 'increased').length;
    return no === 2 ? 'PM' : no === 1 ? 'IM' : inc === 2 ? 'UM' : inc === 1 ? 'RM' : 'NM';
  }
  if (gene === 'CYP2C9') {
    const s = (CYP2C9_ACT[a] ?? NaN) + (CYP2C9_ACT[b] ?? NaN);
    if (!Number.isFinite(s)) return null;
    return s <= 0.5 ? 'PM' : s < 2 ? 'IM' : 'NM';
  }
  // CYP3A5: *1 = expresser, *3/*6/*7 = non-functional
  const expr = [a, b].filter((x) => x === '1').length;
  return expr === 2 ? 'NM' : expr === 1 ? 'IM' : 'PM';
}

/** Child–Pugh score from labs (ascites/encephalopathy assumed absent unless stated). */
export function childPugh(bilirubin?: number, albumin?: number, inr?: number, ascites = 1, enceph = 1): { score: number; cls: Patient['childPugh'] } | null {
  if (bilirubin === undefined || albumin === undefined || inr === undefined) return null;
  const b = bilirubin < 2 ? 1 : bilirubin <= 3 ? 2 : 3;
  const a = albumin > 3.5 ? 1 : albumin >= 2.8 ? 2 : 3;
  const i = inr < 1.7 ? 1 : inr <= 2.3 ? 2 : 3;
  const score = b + a + i + ascites + enceph;
  return { score, cls: score <= 6 ? (bilirubin >= 2 || albumin < 3.5 || inr >= 1.7 ? 'A' : 'none') : score <= 9 ? 'B' : 'C' };
}

function matchMedications(text: string, source: string, findings: Finding[], now: Date): MedicationCourse[] {
  const meds: MedicationCourse[] = [];
  const lower = text.toLowerCase();
  for (const d of DRUGS) {
    const names = [d.name.toLowerCase().split(' (')[0], d.id, ...d.brands.map((b) => b.toLowerCase())].filter((n) => n.length >= 4);
    const hit = names.find((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower));
    if (!hit) continue;
    const near = new RegExp(`${hit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]{0,40}?(\\d+(?:\\.\\d+)?)\\s*(mg|mcg|g)\\b[^\\n]{0,30}?(once daily|daily|od|bid|twice daily|tid|three times|qid|q(\\d+)h|every (\\d+) hours|weekly)?`, 'i').exec(text);
    let dose = d.defaultRegimen.dose;
    let intervalH = d.defaultRegimen.intervalH;
    if (near) {
      dose = Number(near[1]) * (near[2].toLowerCase() === 'mcg' ? 0.001 : near[2].toLowerCase() === 'g' ? 1000 : 1);
      const f = (near[3] ?? '').toLowerCase();
      if (/bid|twice/.test(f)) intervalH = 12;
      else if (/tid|three/.test(f)) intervalH = 8;
      else if (/qid/.test(f)) intervalH = 6;
      else if (/weekly/.test(f)) intervalH = 168;
      else if (/daily|od/.test(f)) intervalH = 24;
      else if (near[4] || near[5]) intervalH = Number(near[4] ?? near[5]);
    }
    meds.push({
      id: `rep_${d.id}`,
      drugId: d.id,
      dose,
      unit: d.defaultRegimen.unit === 'mg/kg' || d.defaultRegimen.unit === 'mg/m2' ? 'mg' : d.defaultRegimen.unit,
      intervalH,
      route: d.defaultRegimen.route,
      infusionH: d.defaultRegimen.infusionH,
      start: new Date(now.getTime() - 30 * 86400000).toISOString(),
      end: now.toISOString(),
      notes: `Imported from ${source}${near ? '' : ' (dose not stated — default regimen assumed)'}`,
    });
    findings.push({ field: 'medication', label: 'Medication', value: `${d.name}${near ? ` ${dose} mg q${intervalH}h` : ''}`, source, confidence: near ? 'high' : 'medium' });
  }
  return meds;
}

/** Parse free text (lab report, discharge summary, genotype report). */
export function parseReportText(text: string, source = 'report', now = new Date()): ReportExtraction {
  const findings: Finding[] = [];
  const patch: Partial<Patient> = {};
  const warnings: string[] = [];
  const vals: Record<string, number> = {};
  for (const r of LAB_RULES) {
    const m = r.re.exec(text);
    if (!m) continue;
    const raw = num(m[1]);
    if (!Number.isFinite(raw)) continue;
    const conv = r.convert ? r.convert(raw, m[2] ?? '') : { value: raw, unit: m[2] ?? '' };
    if (!conv) continue;
    vals[r.field] = conv.value;
    findings.push({ field: r.field, label: r.label, value: conv.value, unit: conv.unit, source, confidence: m[2] ? 'high' : 'medium' });
  }
  if (/\b(female|woman|girl)\b|\bsex\s*[:=]\s*f\b/i.test(text)) {
    patch.sex = 'female';
    findings.push({ field: 'sex', label: 'Sex', value: 'female', source, confidence: 'high' });
  } else if (/\b(male|man|boy)\b|\bsex\s*[:=]\s*m\b/i.test(text)) {
    patch.sex = 'male';
    findings.push({ field: 'sex', label: 'Sex', value: 'male', source, confidence: 'high' });
  }
  if (/\bpregnan/i.test(text) && !/not pregnant|non-?pregnant/i.test(text)) {
    patch.pregnant = true;
    findings.push({ field: 'pregnant', label: 'Pregnancy', value: 'yes', source, confidence: 'medium' });
  }
  if (/\b(current )?smok(er|es|ing)\b/i.test(text) && !/non-?smoker|never smok|ex-?smoker/i.test(text)) patch.smoker = true;
  if (/heart failure|hfref|hfpef|\bchf\b/i.test(text)) {
    patch.heartFailure = true;
    findings.push({ field: 'heartFailure', label: 'Heart failure', value: 'yes', source, confidence: 'medium' });
  }

  const phenotypes: Partial<Patient['phenotypes']> = {};
  for (const gene of ['CYP2D6', 'CYP2C19', 'CYP2C9', 'CYP3A5'] as const) {
    const dip = new RegExp(`${gene}[^\\n*]{0,20}\\*(\\d+(?:xN)?)\\s*\\/\\s*\\*(\\d+(?:xN)?)`, 'i').exec(text);
    if (dip) {
      const ph = diplotypeToPhenotype(gene, dip[1], dip[2]);
      if (ph) {
        phenotypes[gene] = ph;
        findings.push({ field: gene, label: `${gene} *${dip[1]}/*${dip[2]}`, value: ph, source, confidence: 'high' });
        continue;
      }
    }
    const word = new RegExp(`${gene}[^\\n]{0,40}?(ultra[- ]?rapid|rapid|poor|intermediate|normal|extensive)\\s+metaboli[sz]er`, 'i').exec(text);
    if (word) {
      const ph = PHENO_WORDS.find(([re]) => re.test(word[1]))?.[1];
      if (ph) {
        phenotypes[gene] = ph;
        findings.push({ field: gene, label: gene, value: ph, source, confidence: 'high' });
      }
    }
  }
  const vk = /VKORC1[^\n]{0,30}?(GG|AG|GA|AA)\b/i.exec(text);
  if (vk) {
    patch.vkorc1 = (vk[1].toUpperCase() === 'GA' ? 'AG' : vk[1].toUpperCase()) as Patient['vkorc1'];
    findings.push({ field: 'vkorc1', label: 'VKORC1 −1639', value: patch.vkorc1, source, confidence: 'high' });
  }
  const hla: Partial<Patient['hla']> = {};
  if (/HLA-?B\*?15:02[^\n]{0,20}(positive|detected|present)/i.test(text)) hla.B1502 = true;
  if (/HLA-?B\*?57:01[^\n]{0,20}(positive|detected|present)/i.test(text)) hla.B5701 = true;
  if (/HLA-?B\*?58:01[^\n]{0,20}(positive|detected|present)/i.test(text)) hla.B5801 = true;

  if (vals.scr !== undefined) patch.scr = vals.scr;
  if (vals.albumin !== undefined) patch.albumin = vals.albumin;
  if (vals.potassium !== undefined && vals.potassium > 1.5 && vals.potassium < 9) patch.potassium = vals.potassium;
  if (vals.weightKg !== undefined) patch.weightKg = vals.weightKg;
  if (vals.heightCm !== undefined) patch.heightCm = vals.heightCm;
  if (vals.age !== undefined && vals.age > 0 && vals.age < 120) patch.age = vals.age;
  if (vals.qtc !== undefined) patch.baselineQTc = vals.qtc;
  if (vals.hr !== undefined) patch.baselineHR = vals.hr;
  if (vals.sbp !== undefined) patch.baselineSBP = vals.sbp;
  if (Object.keys(phenotypes).length) patch.phenotypes = phenotypes as Patient['phenotypes'];
  if (Object.keys(hla).length) patch.hla = hla as Patient['hla'];

  const cp = childPugh(vals.bilirubin, vals.albumin, vals.inr, /ascites/i.test(text) ? 2 : 1, /encephalopathy/i.test(text) ? 2 : 1);
  if (cp) {
    patch.childPugh = cp.cls;
    findings.push({ field: 'childPugh', label: 'Child–Pugh (estimated)', value: `${cp.cls === 'none' ? 'normal' : cp.cls} (${cp.score} pts)`, source, confidence: 'medium' });
  } else if ((vals.alt ?? 0) > 120 || (vals.ast ?? 0) > 120) {
    warnings.push('Transaminases > 3× ULN: possible active liver injury — Child–Pugh cannot be estimated without bilirubin, albumin and INR.');
  }
  if (vals.egfr !== undefined && vals.scr === undefined) warnings.push('eGFR reported without creatinine — enter serum creatinine for Cockcroft–Gault dosing.');
  const medications = matchMedications(text, source, findings, now);
  return { findings, patch, medications, childPughScore: cp?.score ?? null, warnings };
}

/** Parse a two/three-column CSV (test, value, unit). */
export function parseReportCsv(csv: string, source = 'CSV'): ReportExtraction {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const text = lines.map((l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, '')).join(' ')).join('\n');
  return parseReportText(text, source);
}

const LOINC: Record<string, string> = {
  '2160-0': 'creatinine', '38483-4': 'creatinine', '1751-7': 'albumin', '2823-3': 'potassium', '6298-4': 'potassium', '1742-6': 'ALT', '1920-8': 'AST',
  '1975-2': 'bilirubin', '6301-6': 'INR', '29463-7': 'weight', '3141-9': 'weight', '8302-2': 'height', '8867-4': 'heart rate', '8480-6': 'systolic blood pressure',
  '33914-3': 'eGFR', '62238-1': 'eGFR', '8636-3': 'QTc',
};

/** Parse a FHIR R4 Bundle / resource (Patient, Observation, MedicationStatement / MedicationRequest). */
export function parseFhir(json: unknown, now = new Date()): ReportExtraction {
  const lines: string[] = [];
  const res: unknown[] = [];
  const j = json as { resourceType?: string; entry?: { resource?: unknown }[] };
  if (j?.resourceType === 'Bundle') for (const e of j.entry ?? []) res.push(e.resource);
  else res.push(json);
  for (const r of res.slice(0, 5000)) {
    const x = r as Record<string, unknown> & { resourceType?: string };
    if (x?.resourceType === 'Patient') {
      const g = String(x.gender ?? '');
      if (g) lines.push(`sex: ${g === 'female' ? 'female' : 'male'}`);
      const bd = typeof x.birthDate === 'string' ? Date.parse(x.birthDate) : NaN;
      if (Number.isFinite(bd)) lines.push(`age ${Math.floor((now.getTime() - bd) / (365.25 * 86400000))} years`);
    } else if (x?.resourceType === 'Observation') {
      const code = (x.code as { coding?: { code?: string; display?: string }[]; text?: string }) ?? {};
      const loinc = code.coding?.find((c) => c.code && LOINC[c.code])?.code;
      const name = loinc ? LOINC[loinc] : code.text ?? code.coding?.[0]?.display ?? '';
      const q = x.valueQuantity as { value?: number; unit?: string } | undefined;
      if (name && q?.value !== undefined) lines.push(`${name} ${q.value} ${q.unit ?? ''}`);
      else if (name && typeof x.valueString === 'string') lines.push(`${name} ${x.valueString}`);
    } else if (x?.resourceType === 'MedicationStatement' || x?.resourceType === 'MedicationRequest') {
      const m = (x.medicationCodeableConcept as { text?: string; coding?: { display?: string }[] }) ?? {};
      const dosage = ((x.dosage ?? x.dosageInstruction) as { text?: string }[] | undefined)?.[0]?.text ?? '';
      lines.push(`${m.text ?? m.coding?.[0]?.display ?? ''} ${dosage}`);
    }
  }
  return parseReportText(lines.join('\n'), 'FHIR', now);
}

/** Merge an extraction into a patient (labs and genotypes overwrite; medications appended). */
export function applyExtraction(p: Patient, ex: ReportExtraction): Patient {
  const { phenotypes, hla, ...rest } = ex.patch;
  const existing = new Set(p.medicationHistory.map((m) => m.drugId));
  return {
    ...p,
    ...rest,
    phenotypes: { ...p.phenotypes, ...(phenotypes ?? {}) },
    hla: { ...p.hla, ...(hla ?? {}) },
    medicationHistory: [...p.medicationHistory, ...ex.medications.filter((m) => !existing.has(m.drugId))],
  };
}
