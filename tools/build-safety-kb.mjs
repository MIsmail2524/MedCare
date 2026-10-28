#!/usr/bin/env node
// Build the compact safety knowledge base used by the app from the raw collected dataset.
// Usage: node tools/build-safety-kb.mjs [in=data/drug-safety.json] [out=web/public/data/safety-kb.json]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  SAFETY_ORGANS, organsInText, labelSectionOrgans, evidenceSnippet, faersOrganPRR, bitsToBase64, base64ToBytes, computeBaseRates, leaveOneOut,
} from '../packages/engine/dist/index.js';

const require = createRequire(import.meta.url);
const initRDKit = require('@rdkit/rdkit');

const IN = path.resolve(process.argv[2] ?? 'data/drug-safety.json');
const OUT = path.resolve(process.argv[3] ?? 'web/public/data/safety-kb.json');
const raw = JSON.parse(fs.readFileSync(IN, 'utf8'));
const RDKit = await initRDKit();

// Reference set for disproportionality: pooled reactions of all collected drugs (the whole-database
// count endpoint needs an API key; a within-dataset comparator is standard practice).
const pooled = new Map();
for (const d of raw.drugs) for (const [t, c] of d.faers?.reactions ?? []) pooled.set(t, (pooled.get(t) ?? 0) + c);
const bg = raw.background.reactions?.length ? raw.background.reactions : [...pooled.entries()];
const drugs = [];
for (const d of raw.drugs) {
  if (!d.label) continue;
  const L = d.label;
  const boxedOrgans = new Set(organsInText(L.boxedWarning));
  const warnOrgans = new Set(labelSectionOrgans(L.warnings));
  const prr = faersOrganPRR(d.faers.reactions, bg);
  const anywhere = new Set(organsInText([L.adverseReactions, L.drugInteractions, L.warnings, L.contraindications, L.boxedWarning].join('\n')));
  let fp = null;
  if (d.chem?.smiles) {
    const mol = RDKit.get_mol(d.chem.smiles);
    if (mol) {
      fp = bitsToBase64(mol.get_morgan_fp(JSON.stringify({ radius: 2, nBits: 2048 })));
      mol.delete();
    }
  }
  const organs = {};
  for (const o of SAFETY_ORGANS) {
    const label = boxedOrgans.has(o) ? 2 : warnOrgans.has(o) ? 1 : 0;
    organs[o] = {
      label,
      prr: Math.round(prr[o].prr * 100) / 100,
      count: prr[o].count,
      evidence: label === 2 ? evidenceSnippet(L.boxedWarning, o) : label === 1 ? evidenceSnippet(L.warnings, o) ?? evidenceSnippet(L.contraindications, o) : null,
      terms: prr[o].terms,
      presence: label > 0 ? 'warnings' : anywhere.has(o) ? 'adverse' : 'absent',
    };
  }
  drugs.push({
    name: d.name,
    genericName: L.genericName.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
    brands: L.brandNames,
    classes: [...L.pharmClassEpc, ...L.pharmClassMoa].map((c) => c.replace(/ \[(EPC|MoA)\]$/, '')),
    smiles: d.chem?.smiles ?? null,
    fp,
    chem: { mw: d.chem?.mw ?? null, xlogp: d.chem?.xlogp ?? null, tpsa: d.chem?.tpsa ?? null, hbd: d.chem?.hbd ?? null, hba: d.chem?.hba ?? null, rotb: d.chem?.rotb ?? null },
    faersTotal: d.faers.totalReports,
    boxed: !!L.boxedWarning,
    organs,
    labelSetId: L.setId ?? null,
    labelDate: L.effectiveTime ?? null,
  });
}
console.log(`drugs with labels: ${drugs.length}; with fingerprints: ${drugs.filter((d) => d.fp).length}`);
const validation = leaveOneOut(drugs, (d) => (d.fp ? base64ToBytes(d.fp) : null));
console.log(`LOO macro AUROC ${validation.macroAuroc.toFixed(3)}`);
for (const m of validation.organs) console.log(`  ${m.organ.padEnd(9)} pos ${String(m.positives).padStart(3)}  AUROC ${m.auroc.toFixed(3)}  AUPRC ${m.auprc.toFixed(3)} (base ${m.baseRate.toFixed(2)})`);
const kb = {
  version: 1,
  builtAt: new Date().toISOString(),
  faersTotal: raw.background.totalReports,
  faersUpdated: raw.background.lastUpdated,
  drugs,
  baseRates: computeBaseRates(drugs),
  validation,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(kb));
console.log(`wrote ${OUT} ${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB`);
