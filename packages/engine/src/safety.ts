import type { Organ } from './types.js';

// Open drug-safety knowledge base and organ-liability model.
//
// Ground truth: organ systems named in the FDA label's Boxed Warning or Warnings & Precautions
// (regulator-reviewed). Post-market signal: FAERS disproportionality (proportional reporting
// ratio, PRR) aggregated by organ system. Prediction for any molecule: similarity-weighted
// nearest-neighbour inference over structure (Morgan/ECFP4 Tanimoto) and FDA pharmacologic
// class, with Bayesian smoothing toward the base rate and an explicit applicability domain.

export const SAFETY_ORGANS: Organ[] = ['liver', 'kidneys', 'heart', 'blood', 'skin', 'brain', 'lungs', 'gi', 'pancreas', 'muscle', 'thyroid'];

export const ORGAN_TERMS: Record<Organ, RegExp> = {
  liver: /hepatotox|hepatic (failure|injury|necrosis|toxicity|impairment)|liver (injury|failure|damage|disorder|function test)|hepatitis|jaundice|transaminase|aminotransferase|\balt\b|\bast\b|hyperbilirubin|cholesta|drug-induced liver/i,
  kidneys: /nephrotox|renal (failure|injury|impairment|toxicity|tubular|disorder)|kidney (injury|failure|disorder)|interstitial nephritis|creatinine increased|blood creatinine|acute kidney|nephropathy|azotemia/i,
  heart: /qt (interval )?prolong|torsade|arrhythmi|heart failure|cardiac failure|cardiomyopathy|myocardial infarction|cardiotox|cardiac arrest|ventricular (tachy|fibril)|bradycardia|heart block|atrioventricular block|cardiovascular (thrombotic )?events|atrial fibrillation|palpitation/i,
  blood: /bleed|h(a)?emorrhag|agranulocytosis|neutropeni|thrombocytopeni|aplastic an(a)?emia|myelosuppress|bone marrow (suppression|failure)|pancytopeni|an(a)?emia|h(a)?emoly|leukopeni|coagulopathy|inr increased|febrile neutropenia/i,
  skin: /stevens-johnson|toxic epidermal|dermatolog|cutaneous|\bdress\b|drug reaction with eosinophilia|serious skin|severe cutaneous|rash|angioedema|exfoliative|urticaria|pruritus|photosensitiv|erythema multiforme/i,
  brain: /seizure|convulsion|suicid|serotonin syndrome|neuroleptic malignant|somnolence|cns depression|central nervous system depression|encephalopathy|neurotox|neuropathy|tardive|extrapyramidal|confusion|delirium|dizziness|coma|syncope|sedation|hallucination|ataxia|stroke|cerebrovascular/i,
  lungs: /respiratory depression|interstitial lung|pneumonitis|pulmonary (toxicity|fibrosis|embolism|hypertension|oedema|edema)|bronchospasm|respiratory failure|dyspno|apnoea|apnea|acute respiratory/i,
  gi: /gastrointestinal (bleeding|perforation|ulcer|haemorrhage|hemorrhage|toxicity)|\bulcer|perforation|colitis|clostridi|difficile|diarrh|vomit|nausea|ileus|constipation/i,
  pancreas: /pancreatit|hypoglyc|hyperglyc|diabetic ketoacidosis|ketoacidosis|lactic acidosis|hba1c|serum glucose|blood glucose/i,
  muscle: /rhabdomyolysis|myopathy|tendon (rupture|disorder)|tendinitis|tendinopathy|myasthenia|myalgia|blood creatine phosphokinase/i,
  thyroid: /thyroid|hypothyroid|hyperthyroid|endocrinopath/i,
};

/** Organs mentioned in a block of text. */
export function organsInText(text: string | null | undefined): Organ[] {
  if (!text) return [];
  return SAFETY_ORGANS.filter((o) => ORGAN_TERMS[o].test(text));
}

/** First sentence in `text` that mentions `organ` (evidence snippet). */
export function evidenceSnippet(text: string | null | undefined, organ: Organ, max = 260): string | null {
  if (!text) return null;
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.;])\s+/);
  const hit = sentences.find((s) => ORGAN_TERMS[organ].test(s));
  if (!hit) return null;
  return hit.length > max ? hit.slice(0, max - 1) + '…' : hit;
}

/**
 * Organs that a label section treats as a distinct safety topic. PLR-format labels number their
 * Warnings & Precautions subsections ("5.1 Hepatotoxicity …"); only those headings count. Older
 * labels without numbered subsections require ≥ 2 independent mentions of the organ.
 */
export function labelSectionOrgans(text: string | null | undefined): Organ[] {
  if (!text) return [];
  const heads = [...text.matchAll(/\b5\.\d{1,2}\s+((?:(?!\b5\.\d)[^()]){3,90})/g)].map((m) => m[1].split(/\s+/).slice(0, 7).join(' '));
  if (heads.length >= 2) {
    const set = new Set<Organ>();
    for (const h of heads) for (const o of SAFETY_ORGANS) if (ORGAN_TERMS[o].test(h)) set.add(o);
    return [...set];
  }
  return SAFETY_ORGANS.filter((o) => (text.match(new RegExp(ORGAN_TERMS[o].source, 'gi')) ?? []).length >= 2);
}

export function organForReaction(term: string): Organ | null {
  for (const o of SAFETY_ORGANS) if (ORGAN_TERMS[o].test(term)) return o;
  return null;
}

/** Proportional reporting ratio per organ from FAERS term counts (drug vs. whole database). */
export function faersOrganPRR(drugReactions: [string, number][], background: [string, number][]): Record<Organ, { count: number; prr: number; terms: [string, number][] }> {
  const agg = (rows: [string, number][]) => {
    const out = Object.fromEntries(SAFETY_ORGANS.map((o) => [o, 0])) as Record<Organ, number>;
    let total = 0;
    for (const [t, c] of rows) {
      total += c;
      const o = organForReaction(t);
      if (o) out[o] += c;
    }
    return { out, total };
  };
  const d = agg(drugReactions);
  const b = agg(background);
  const res = {} as Record<Organ, { count: number; prr: number; terms: [string, number][] }>;
  for (const o of SAFETY_ORGANS) {
    const a = d.out[o];
    const pDrug = d.total ? a / d.total : 0;
    const pBg = b.total ? (b.out[o] - Math.min(a, b.out[o])) / Math.max(b.total - d.total, 1) : 0;
    res[o] = {
      count: a,
      prr: pBg > 0 ? pDrug / pBg : 0,
      terms: drugReactions.filter(([t]) => organForReaction(t) === o).slice(0, 6),
    };
  }
  return res;
}

// ---------------------------------------------------------------------------
// Knowledge-base record (as produced by tools/build-safety-kb.mjs)

export interface KBOrgan {
  /** 2 = boxed warning, 1 = warnings & precautions / contraindications, 0 = not labelled */
  label: 0 | 1 | 2;
  prr: number;
  count: number;
  evidence: string | null;
  terms: [string, number][];
  /** Where the organ appears anywhere in the label text: 'warnings' (boxed/W&P), 'adverse' (adverse-reactions or other sections only) or 'absent'. */
  presence?: 'warnings' | 'adverse' | 'absent';
}

export interface KBDrug {
  name: string;
  genericName: string;
  brands: string[];
  classes: string[];
  smiles: string | null;
  /** Morgan radius-2, 2048-bit fingerprint, base64 of packed bits */
  fp: string | null;
  chem: { mw: number | null; xlogp: number | null; tpsa: number | null; hbd: number | null; hba: number | null; rotb: number | null };
  faersTotal: number;
  boxed: boolean;
  organs: Record<Organ, KBOrgan>;
  labelSetId: string | null;
  labelDate: string | null;
}

export interface SafetyKB {
  version: number;
  builtAt: string;
  faersTotal: number;
  faersUpdated: string | null;
  drugs: KBDrug[];
  baseRates: Record<Organ, number>;
  validation: ValidationReport | null;
}

// ---------------------------------------------------------------------------
// Fingerprints & similarity

export function bitsToBase64(bits: string): string {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i] === '1') bytes[i >> 3] |= 1 << (i & 7);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const POP = new Uint8Array(256).map((_, i) => {
  let c = 0;
  let x = i;
  while (x) {
    c += x & 1;
    x >>= 1;
  }
  return c;
});

export function tanimoto(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < a.length; i++) {
    inter += POP[a[i] & b[i]];
    uni += POP[a[i] | b[i]];
  }
  return uni ? inter / uni : 0;
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  let inter = 0;
  for (const x of new Set(b)) if (sa.has(x)) inter++;
  return inter / (sa.size + new Set(b).size - inter);
}

/** Model hyperparameters (selected by leave-one-out sweep; see tools/build-safety-kb.mjs). */
export const MODEL_PARAMS = { k: 8, alpha: 0.2, wStruct: 0.55, power: 3 };

export interface Query {
  name?: string;
  fp?: Uint8Array | null;
  classes?: string[];
  chem?: Partial<KBDrug['chem']>;
}

export interface Neighbour {
  drug: KBDrug;
  structural: number;
  pharmacological: number;
  similarity: number;
}

export function similarity(q: Query, d: KBDrug, fpCache?: Map<string, Uint8Array>, wStruct = 0.55): Neighbour {
  let structural = 0;
  if (q.fp && d.fp) {
    let dfp = fpCache?.get(d.name);
    if (!dfp) {
      dfp = base64ToBytes(d.fp);
      fpCache?.set(d.name, dfp);
    }
    structural = tanimoto(q.fp, dfp);
  }
  const pharmacological = jaccard(q.classes ?? [], d.classes);
  const hasS = !!(q.fp && d.fp);
  const hasP = !!(q.classes?.length && d.classes.length);
  const sim = hasS && hasP ? wStruct * structural + (1 - wStruct) * pharmacological : hasS ? structural : hasP ? pharmacological : 0;
  return { drug: d, structural, pharmacological, similarity: sim };
}

export interface LiabilityPrediction {
  organ: Organ;
  probability: number;
  /** 0–1: weight of evidence from neighbours relative to the prior */
  support: number;
  boxedLikely: boolean;
  evidence: { drug: string; similarity: number; label: 0 | 1 | 2; prr: number }[];
}

export interface PredictionResult {
  liabilities: LiabilityPrediction[];
  neighbours: Neighbour[];
  applicability: { maxSimilarity: number; inDomain: boolean; note: string };
}

/**
 * Predict organ-level label liabilities for a molecule from its structural and pharmacological
 * neighbours. p = (Σ wᵢ yᵢ + α·base) / (Σ wᵢ + α), wᵢ = simᵢ³ over the k most similar drugs.
 */
export function predictLiabilities(q: Query, kb: Pick<SafetyKB, 'drugs' | 'baseRates'>, opts: { k?: number; alpha?: number; wStruct?: number; power?: number; exclude?: string; fpCache?: Map<string, Uint8Array> } = {}): PredictionResult {
  const k = opts.k ?? MODEL_PARAMS.k;
  const alpha = opts.alpha ?? MODEL_PARAMS.alpha;
  const power = opts.power ?? MODEL_PARAMS.power;
  const neigh = kb.drugs
    .filter((d) => d.name !== opts.exclude)
    .map((d) => similarity(q, d, opts.fpCache, opts.wStruct ?? MODEL_PARAMS.wStruct))
    .filter((n) => n.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
  const maxSim = neigh[0]?.similarity ?? 0;
  const liabilities: LiabilityPrediction[] = SAFETY_ORGANS.map((organ) => {
    let num = 0;
    let den = 0;
    let boxed = 0;
    for (const n of neigh) {
      const w = n.similarity ** power;
      const lab = n.drug.organs[organ]?.label ?? 0;
      num += w * (lab > 0 ? 1 : 0);
      boxed += w * (lab === 2 ? 1 : 0);
      den += w;
    }
    const base = kb.baseRates[organ] ?? 0.2;
    const p = (num + alpha * base) / (den + alpha);
    return {
      organ,
      probability: p,
      support: den / (den + alpha),
      boxedLikely: den > 0 && boxed / den > 0.4,
      evidence: neigh
        .filter((n) => (n.drug.organs[organ]?.label ?? 0) > 0 || (n.drug.organs[organ]?.prr ?? 0) >= 2)
        .slice(0, 4)
        .map((n) => ({ drug: n.drug.genericName, similarity: n.similarity, label: n.drug.organs[organ].label, prr: n.drug.organs[organ].prr })),
    };
  }).sort((a, b) => b.probability - a.probability);
  const inDomain = maxSim >= 0.35;
  return {
    liabilities,
    neighbours: neigh,
    applicability: {
      maxSimilarity: maxSim,
      inDomain,
      note: inDomain
        ? `Closest analogue similarity ${maxSim.toFixed(2)} — prediction is supported by related approved drugs.`
        : `Closest analogue similarity ${maxSim.toFixed(2)} — structurally/pharmacologically novel. Predictions revert toward base rates; treat as hypothesis-generating and prioritise experimental safety data.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Validation: leave-one-out against FDA label organ warnings

export interface OrganMetric {
  organ: Organ;
  positives: number;
  auroc: number;
  auprc: number;
  baseRate: number;
}

export interface ValidationReport {
  method: string;
  n: number;
  macroAuroc: number;
  organs: OrganMetric[];
  /** For calibration plots: [predicted, observed] in deciles across all organs */
  calibration: { predicted: number; observed: number; n: number }[];
}

export function auroc(scores: number[], labels: number[]): number {
  const pos = scores.filter((_, i) => labels[i] === 1);
  const neg = scores.filter((_, i) => labels[i] === 0);
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export function auprc(scores: number[], labels: number[]): number {
  const idx = scores.map((s, i) => [s, labels[i]] as const).sort((a, b) => b[0] - a[0]);
  const P = labels.filter((l) => l === 1).length;
  if (!P) return NaN;
  let tp = 0;
  let ap = 0;
  idx.forEach(([, l], i) => {
    if (l === 1) {
      tp++;
      ap += tp / (i + 1);
    }
  });
  return ap / P;
}

export function computeBaseRates(drugs: KBDrug[]): Record<Organ, number> {
  return Object.fromEntries(SAFETY_ORGANS.map((o) => [o, drugs.filter((d) => (d.organs[o]?.label ?? 0) > 0).length / Math.max(drugs.length, 1)])) as Record<Organ, number>;
}

export function leaveOneOut(drugs: KBDrug[], fpFor: (d: KBDrug) => Uint8Array | null, params: Partial<typeof MODEL_PARAMS> = {}): ValidationReport {
  const fpCache = new Map<string, Uint8Array>();
  const scores: Record<string, number[]> = {};
  const labels: Record<string, number[]> = {};
  const pairs: [number, number][] = [];
  for (const d of drugs) {
    const rest = drugs.filter((x) => x !== d);
    const base = computeBaseRates(rest);
    const pred = predictLiabilities({ fp: fpFor(d), classes: d.classes }, { drugs: rest, baseRates: base }, { fpCache, ...params });
    for (const l of pred.liabilities) {
      (scores[l.organ] ??= []).push(l.probability);
      const y = (d.organs[l.organ]?.label ?? 0) > 0 ? 1 : 0;
      (labels[l.organ] ??= []).push(y);
      pairs.push([l.probability, y]);
    }
  }
  const organs = SAFETY_ORGANS.map((o) => ({
    organ: o,
    positives: labels[o].filter((x) => x === 1).length,
    auroc: auroc(scores[o], labels[o]),
    auprc: auprc(scores[o], labels[o]),
    baseRate: labels[o].filter((x) => x === 1).length / labels[o].length,
  }));
  const valid = organs.filter((m) => Number.isFinite(m.auroc));
  pairs.sort((a, b) => a[0] - b[0]);
  const calibration: ValidationReport['calibration'] = [];
  for (let i = 0; i < 10; i++) {
    const slice = pairs.slice(Math.floor((i * pairs.length) / 10), Math.floor(((i + 1) * pairs.length) / 10));
    if (!slice.length) continue;
    calibration.push({ predicted: slice.reduce((s, p) => s + p[0], 0) / slice.length, observed: slice.reduce((s, p) => s + p[1], 0) / slice.length, n: slice.length });
  }
  return {
    method: `Leave-one-drug-out; similarity-weighted k-NN (k=${params.k ?? MODEL_PARAMS.k}, weight sim^${params.power ?? MODEL_PARAMS.power}, ${Math.round((params.wStruct ?? MODEL_PARAMS.wStruct) * 100)}% Morgan-2 Tanimoto + ${Math.round((1 - (params.wStruct ?? MODEL_PARAMS.wStruct)) * 100)}% FDA pharmacologic-class Jaccard); label = organ named in Boxed Warning or Warnings & Precautions subsection headings.`,
    n: drugs.length,
    macroAuroc: valid.reduce((s, m) => s + m.auroc, 0) / Math.max(valid.length, 1),
    organs,
    calibration,
  };
}

// ---------------------------------------------------------------------------
// Post-market signal-gap detection

export interface SignalGap {
  drug: string;
  organ: Organ;
  prr: number;
  count: number;
  terms: [string, number][];
  strength: 'strong' | 'moderate';
  presence: 'adverse' | 'absent';
}

/** Organs with a disproportionate FAERS signal that are not named in the label's warnings. */
export function signalGaps(kb: Pick<SafetyKB, 'drugs'>, minPrr = 2, minCount = 25): SignalGap[] {
  const out: SignalGap[] = [];
  for (const d of kb.drugs) {
    for (const o of SAFETY_ORGANS) {
      const x = d.organs[o];
      if (!x || x.label > 0 || x.presence === 'warnings') continue;
      const presence = x.presence === 'adverse' ? 'adverse' : 'absent';
      // An organ mentioned only under Adverse Reactions needs a stronger signal to be flagged.
      const need = presence === 'adverse' ? minPrr * 2 : minPrr;
      if (x.prr >= need && x.count >= minCount) out.push({ drug: d.genericName, organ: o, prr: x.prr, count: x.count, terms: x.terms, presence, strength: presence === 'absent' && x.prr >= 4 && x.count >= 100 ? 'strong' : 'moderate' });
    }
  }
  return out.sort((a, b) => b.prr * Math.log(b.count) - a.prr * Math.log(a.count));
}

export function findKBDrug(kb: Pick<SafetyKB, 'drugs'>, name: string): KBDrug | undefined {
  const n = name.toLowerCase();
  return kb.drugs.find((d) => d.name === n || d.genericName.toLowerCase() === n || d.genericName.toLowerCase().startsWith(n + ' ') || d.brands.some((b) => b.toLowerCase() === n));
}
