#!/usr/bin/env node
// Collect an open drug-safety knowledge base from public-domain US government sources:
//   • openFDA drug labels (SPL): boxed warning, warnings, contraindications, adverse reactions,
//     interactions, FDA Established Pharmacologic Class / mechanism
//   • openFDA FAERS: adverse-event report counts per MedDRA preferred term
//   • PubChem: structure (SMILES) and physicochemical descriptors
// openFDA data are public domain (https://open.fda.gov/license/); PubChem data are public domain.
// FAERS reports are spontaneous, unverified and do not establish causation.
//
// Usage: node tools/collect-datasets.mjs [out=data/drug-safety.json]
// Resumable: progress is checkpointed in <out>.partial.json. Set OPENFDA_API_KEY for higher limits.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const OUT = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'data/drug-safety.json');
const PARTIAL = OUT + '.partial.json';
const KEY = process.env.OPENFDA_API_KEY ? `&api_key=${encodeURIComponent(process.env.OPENFDA_API_KEY)}` : '';

export const DRUG_NAMES = [
  // cardiovascular
  'amiodarone', 'digoxin', 'warfarin', 'apixaban', 'rivaroxaban', 'dabigatran', 'clopidogrel', 'ticagrelor', 'prasugrel', 'aspirin', 'heparin', 'enoxaparin',
  'metoprolol', 'carvedilol', 'atenolol', 'propranolol', 'bisoprolol', 'amlodipine', 'diltiazem', 'verapamil', 'nifedipine', 'lisinopril', 'enalapril', 'ramipril',
  'losartan', 'valsartan', 'sacubitril', 'spironolactone', 'eplerenone', 'furosemide', 'hydrochlorothiazide', 'chlorthalidone', 'torsemide', 'atorvastatin',
  'simvastatin', 'rosuvastatin', 'pravastatin', 'ezetimibe', 'dofetilide', 'sotalol', 'flecainide', 'dronedarone', 'hydralazine', 'isosorbide mononitrate', 'ranolazine',
  // anti-infectives
  'vancomycin', 'gentamicin', 'amikacin', 'tobramycin', 'ciprofloxacin', 'levofloxacin', 'moxifloxacin', 'clarithromycin', 'azithromycin', 'erythromycin', 'doxycycline',
  'minocycline', 'amoxicillin', 'piperacillin', 'ceftriaxone', 'cefepime', 'meropenem', 'linezolid', 'daptomycin', 'trimethoprim', 'sulfamethoxazole', 'nitrofurantoin',
  'metronidazole', 'clindamycin', 'rifampin', 'isoniazid', 'pyrazinamide', 'ethambutol', 'fluconazole', 'voriconazole', 'itraconazole', 'posaconazole', 'amphotericin b',
  'acyclovir', 'valganciclovir', 'oseltamivir', 'tenofovir disoproxil fumarate', 'efavirenz', 'abacavir', 'dolutegravir', 'ritonavir', 'hydroxychloroquine', 'chloroquine',
  // CNS / psychiatry / pain
  'acetaminophen', 'ibuprofen', 'naproxen', 'celecoxib', 'diclofenac', 'ketorolac', 'morphine', 'oxycodone', 'hydromorphone', 'fentanyl', 'methadone', 'tramadol',
  'codeine', 'buprenorphine', 'naloxone', 'gabapentin', 'pregabalin', 'duloxetine', 'venlafaxine', 'fluoxetine', 'sertraline', 'citalopram', 'escitalopram',
  'paroxetine', 'bupropion', 'mirtazapine', 'trazodone', 'amitriptyline', 'nortriptyline', 'lithium carbonate', 'valproic acid', 'lamotrigine', 'carbamazepine',
  'oxcarbazepine', 'phenytoin', 'levetiracetam', 'topiramate', 'haloperidol', 'quetiapine', 'olanzapine', 'risperidone', 'aripiprazole', 'clozapine', 'ziprasidone',
  'midazolam', 'lorazepam', 'diazepam', 'alprazolam', 'zolpidem', 'propofol', 'ketamine', 'methylphenidate', 'donepezil', 'memantine', 'levodopa', 'sumatriptan',
  // endocrine / metabolic
  'metformin', 'glipizide', 'glyburide', 'pioglitazone', 'sitagliptin', 'empagliflozin', 'dapagliflozin', 'canagliflozin', 'liraglutide', 'semaglutide', 'insulin glargine',
  'levothyroxine', 'methimazole', 'propylthiouracil', 'prednisone', 'dexamethasone', 'hydrocortisone', 'alendronate', 'allopurinol', 'febuxostat', 'colchicine',
  // GI / respiratory / other
  'omeprazole', 'pantoprazole', 'esomeprazole', 'famotidine', 'ondansetron', 'metoclopramide', 'loperamide', 'theophylline', 'montelukast', 'albuterol', 'tiotropium',
  // oncology / immunology / transplant
  'methotrexate', 'doxorubicin', 'cisplatin', 'carboplatin', 'paclitaxel', 'docetaxel', 'cyclophosphamide', 'fluorouracil', 'capecitabine', 'imatinib', 'tamoxifen',
  'letrozole', 'anastrozole', 'trastuzumab', 'bevacizumab', 'pembrolizumab', 'nivolumab', 'rituximab', 'tacrolimus', 'cyclosporine', 'mycophenolate mofetil',
  'azathioprine', 'leflunomide', 'adalimumab', 'infliximab', 'tofacitinib', 'sildenafil', 'finasteride', 'tamsulosin', 'oxybutynin', 'isotretinoin', 'terbinafine',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// HTTP via curl (args array, no shell): more robust than Node sockets in sandboxed environments.
function curl(url) {
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '--max-time', '60', '-A', 'MedCareTwin-dataset-builder/1.0 (research)', '-w', '\n%{http_code}', url], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve({ status: 0, body: '' });
      const i = stdout.lastIndexOf('\n');
      resolve({ status: Number(stdout.slice(i + 1)) || 0, body: stdout.slice(0, i) });
    });
  });
}
async function getJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const { status, body } = await curl(url);
    if (status === 404) return null;
    if (status === 429 || status >= 500 || status === 0) {
      await sleep(2000 * (i + 1));
      continue;
    }
    if (status !== 200) return null;
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return null;
}
const q = (s) => encodeURIComponent(`"${s}"`);
const clip = (arr, n = 6000) => (Array.isArray(arr) ? arr.join('\n') : arr ?? '').slice(0, n);

async function label(name) {
  let r = await getJson(`https://api.fda.gov/drug/label.json?search=openfda.generic_name:${q(name)}+AND+(openfda.route:ORAL+OR+openfda.route:INTRAVENOUS+OR+openfda.route:SUBCUTANEOUS)&limit=10${KEY}`);
  if (!r?.results?.length) r = await getJson(`https://api.fda.gov/drug/label.json?search=openfda.generic_name:${q(name)}&limit=10${KEY}`);
  if (!r?.results?.length) return null;
  const up = name.toUpperCase();
  const score = (x) => {
    const gn = x.openfda?.generic_name ?? [];
    let s = 0;
    if (gn.some((g) => g === up || g.startsWith(up + ' '))) s += 4;
    if (gn.length === 1 && !gn[0].includes(' AND ')) s += 2;
    if (x.openfda?.pharm_class_epc) s += 2;
    if (x.boxed_warning || x.warnings_and_cautions) s += 1;
    if (x.adverse_reactions) s += 1;
    // Prefer systemic products (oral/IV/SC…) over topical, ophthalmic, otic, vaginal or nasal ones.
    const routes = x.openfda?.route ?? [];
    if (routes.some((r) => /ORAL|INTRAVENOUS|SUBCUTANEOUS|INTRAMUSCULAR|TRANSDERMAL|INHALATION|RESPIRATORY|SUBLINGUAL|BUCCAL/.test(r))) s += 5;
    return s;
  };
  const best = r.results.slice().sort((a, b) => score(b) - score(a))[0];
  return {
    setId: best.set_id,
    effectiveTime: best.effective_time,
    genericName: best.openfda?.generic_name?.[0] ?? name,
    brandNames: (best.openfda?.brand_name ?? []).slice(0, 4),
    route: best.openfda?.route ?? [],
    pharmClassEpc: best.openfda?.pharm_class_epc ?? [],
    pharmClassMoa: best.openfda?.pharm_class_moa ?? [],
    pharmClassCs: best.openfda?.pharm_class_cs ?? [],
    boxedWarning: clip(best.boxed_warning, 3000),
    warnings: clip(best.warnings_and_cautions ?? best.warnings, 8000),
    contraindications: clip(best.contraindications, 2500),
    adverseReactions: clip(best.adverse_reactions, 8000),
    drugInteractions: clip(best.drug_interactions, 4000),
    mechanism: clip(best.mechanism_of_action, 1500),
  };
}

async function faers(name) {
  const base = `https://api.fda.gov/drug/event.json?search=patient.drug.openfda.generic_name:${q(name)}+AND+patient.drug.drugcharacterization:1${KEY}`;
  const tot = await getJson(`${base}&limit=1`);
  await sleep(300);
  const cnt = await getJson(`${base}&count=patient.reaction.reactionmeddrapt.exact&limit=150`);
  return { totalReports: tot?.meta?.results?.total ?? 0, reactions: (cnt?.results ?? []).map((x) => [x.term, x.count]) };
}

async function pubchem(name) {
  const props = 'MolecularWeight,XLogP,TPSA,HBondDonorCount,HBondAcceptorCount,RotatableBondCount,HeavyAtomCount,Complexity,Charge,IsomericSMILES';
  const r = await getJson(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(name)}/property/${props}/JSON`);
  const p = r?.PropertyTable?.Properties?.[0];
  if (!p) return null;
  return {
    cid: p.CID,
    smiles: p.SMILES ?? p.IsomericSMILES ?? null,
    mw: Number(p.MolecularWeight),
    xlogp: p.XLogP ?? null,
    tpsa: p.TPSA ?? null,
    hbd: p.HBondDonorCount ?? null,
    hba: p.HBondAcceptorCount ?? null,
    rotb: p.RotatableBondCount ?? null,
    heavy: p.HeavyAtomCount ?? null,
    complexity: p.Complexity ?? null,
    charge: p.Charge ?? 0,
  };
}

async function background() {
  const all = await getJson(`https://api.fda.gov/drug/event.json?limit=1${KEY}`);
  await sleep(300);
  const top = await getJson(`https://api.fda.gov/drug/event.json?count=patient.reaction.reactionmeddrapt.exact&limit=1000${KEY}`);
  return { totalReports: all?.meta?.results?.total ?? 0, reactions: (top?.results ?? []).map((x) => [x.term, x.count]), lastUpdated: all?.meta?.last_updated ?? null };
}

const state = fs.existsSync(PARTIAL) ? JSON.parse(fs.readFileSync(PARTIAL, 'utf8')) : { drugs: {}, background: null };
const save = () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(PARTIAL, JSON.stringify(state));
};
if (!state.background || !state.background.totalReports) {
  state.background = await background();
  save();
  console.log(`FAERS background: ${state.background.totalReports} reports`);
}
// --refresh=a,b,c re-collects only the label for the named drugs.
const refresh = (process.argv.find((a) => a.startsWith('--refresh=')) ?? '').slice(10).split(',').filter(Boolean);
for (const n of refresh) {
  if (!state.drugs[n]) continue;
  state.drugs[n].label = await label(n);
  console.log(`refreshed ${n}: ${state.drugs[n].label?.route?.join('/')}`);
  await sleep(300);
}
if (refresh.length) save();
let i = 0;
const todo = DRUG_NAMES.filter((n) => !state.drugs[n]?.done);
async function worker() {
  while (todo.length) {
    const name = todo.shift();
    const lab = await label(name);
    await sleep(250);
    const fa = await faers(name);
    await sleep(250);
    const pc = await pubchem(name);
    state.drugs[name] = { name, label: lab, faers: fa, chem: pc, done: true };
    save();
    i++;
    console.log(`${Object.keys(state.drugs).length}/${DRUG_NAMES.length} ${name}: label ${lab ? 'yes' : 'no'}, FAERS ${fa.totalReports}, SMILES ${pc?.smiles ? 'yes' : 'no'}`);
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
const out = {
  version: 1,
  builtAt: new Date().toISOString(),
  sources: {
    openfda: 'https://open.fda.gov (public domain). FAERS reports are unverified and do not establish causation.',
    pubchem: 'https://pubchem.ncbi.nlm.nih.gov (public domain).',
  },
  background: state.background,
  drugs: Object.values(state.drugs).map(({ done, ...d }) => d),
};
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB, ${out.drugs.length} drugs)`);
