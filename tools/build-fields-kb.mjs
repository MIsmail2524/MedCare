// Builds the static Twin-lab knowledge base from data/fields.json:
//   • FAERS age-band reporting signals per drug
//   • leave-one-out validation of the structure/class kNN age-risk model (Spearman ρ)
//   • FDA drug shortages and FDA CVM veterinary adverse-event summaries
// Usage: node tools/build-fields-kb.mjs [in=data/fields.json] [kb=web/public/data/safety-kb.json] [out=web/public/data/fields-kb.json]
import fs from 'node:fs';
import path from 'node:path';
import { ageSignals, validateAgeModel } from '../packages/engine/dist/index.js';

const IN = path.resolve(process.argv[2] ?? 'data/fields.json');
const KB = path.resolve(process.argv[3] ?? 'web/public/data/safety-kb.json');
const OUT = path.resolve(process.argv[4] ?? 'web/public/data/fields-kb.json');

const data = JSON.parse(fs.readFileSync(IN, 'utf8'));
const kb = JSON.parse(fs.readFileSync(KB, 'utf8'));
const signals = ageSignals(data.ages);
const report = validateAgeModel(kb, data.ages);
console.log(`age signals: ${signals.length}; model n=${report.n} ρ(elderly)=${report.spearmanElderly.toFixed(3)} ρ(paediatric)=${report.spearmanPaediatric.toFixed(3)}`);

const out = {
  ageSignals: signals,
  ageModel: report.n >= 10 ? { n: report.n, spearmanElderly: report.spearmanElderly, spearmanPaediatric: report.spearmanPaediatric } : null,
  shortages: data.shortages ?? [],
  vet: data.vet ?? {},
  builtAt: new Date().toISOString(),
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
