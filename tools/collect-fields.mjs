#!/usr/bin/env node
// Second-wave public datasets (openFDA, public domain):
//   • FAERS age distribution per drug (years) → paediatric / geriatric reporting signals
//   • FDA drug shortages (current status, therapeutic category)
//   • FDA CVM veterinary adverse events: top active ingredients and reactions by species
// Usage: node tools/collect-fields.mjs [out=data/fields.json]   (resumable via <out>.partial.json)
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const OUT = path.resolve(process.argv[2] ?? 'data/fields.json');
const PARTIAL = OUT.replace(/\.json$/, '') + '.partial.json';
const KEY = process.env.OPENFDA_API_KEY ? `&api_key=${encodeURIComponent(process.env.OPENFDA_API_KEY)}` : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function curl(url) {
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '--max-time', '90', '-A', 'MedCareTwin-dataset-builder/1.0 (research)', '-w', '\n%{http_code}', url], { maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      if (err && !out) return resolve({ status: 0, body: '' });
      const i = out.lastIndexOf('\n');
      resolve({ status: Number(out.slice(i + 1)) || 0, body: out.slice(0, i) });
    });
  });
}
async function getJson(url) {
  for (let i = 0; i < 4; i++) {
    const { status, body } = await curl(url + KEY);
    if (status === 404) return null;
    if (status === 0 && !body) return null; // curl timeout: skip, retried on the next run
    if (status === 429 || body.includes('API_KEY_MISSING')) throw new Error('openFDA daily limit reached — re-run tomorrow or set OPENFDA_API_KEY (progress is saved)');
    if (status !== 200) {
      await sleep(2000 * (i + 1));
      continue;
    }
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return null;
}
const q = (s) => encodeURIComponent(`"${s}"`);

const kb = JSON.parse(fs.readFileSync('data/drug-safety.json', 'utf8'));
const names = kb.drugs.filter((d) => d.label).map((d) => d.name);
const state = fs.existsSync(PARTIAL) ? JSON.parse(fs.readFileSync(PARTIAL, 'utf8')) : { ages: {}, shortages: null, vet: null };
const save = () => fs.writeFileSync(PARTIAL, JSON.stringify(state));

try {
  if (!state.shortages) {
    const all = [];
    for (let skip = 0; skip < 3000; skip += 1000) {
      const r = await getJson(`https://api.fda.gov/drug/shortages.json?limit=1000&skip=${skip}`);
      if (!r?.results?.length) break;
      for (const x of r.results) all.push({ generic: x.generic_name ?? x.openfda?.generic_name?.[0] ?? '', status: x.status ?? '', category: x.therapeutic_category ?? [], reason: x.shortage_reason ?? '', updated: x.update_date ?? '', presentation: x.presentation ?? '' });
      if (r.results.length < 1000) break;
      await sleep(400);
    }
    state.shortages = all;
    save();
    console.log(`shortages: ${all.length}`);
  }
  if (!state.vet) {
    const vet = {};
    for (const sp of ['Dog', 'Cat', 'Cattle', 'Horse']) {
      const ing = await getJson(`https://api.fda.gov/animalandveterinary/event.json?search=animal.species:${q(sp)}&count=drug.active_ingredients.name.exact&limit=40`);
      await sleep(400);
      const rx = await getJson(`https://api.fda.gov/animalandveterinary/event.json?search=animal.species:${q(sp)}&count=reaction.veddra_term_name.exact&limit=40`);
      await sleep(400);
      vet[sp] = { ingredients: (ing?.results ?? []).map((x) => [x.term, x.count]), reactions: (rx?.results ?? []).map((x) => [x.term, x.count]) };
    }
    state.vet = vet;
    save();
    console.log('veterinary events collected');
  }
  const todo = names.filter((n) => !state.ages[n]);
  let done = 0;
  async function worker() {
    while (todo.length) {
      const n = todo.shift();
      const r = await getJson(`https://api.fda.gov/drug/event.json?search=patient.drug.openfda.generic_name:${q(n)}+AND+patient.patientonsetageunit:801&count=patient.patientonsetage&limit=1000`);
      if (!r?.results) { console.warn(`ages: no data for ${n}`); done++; continue; }
      const bands = { '0-1': 0, '2-11': 0, '12-17': 0, '18-44': 0, '45-64': 0, '65-74': 0, '75+': 0 };
      for (const x of r?.results ?? []) {
        const a = Number(x.term);
        if (!Number.isFinite(a) || a < 0 || a > 110) continue;
        const b = a < 2 ? '0-1' : a < 12 ? '2-11' : a < 18 ? '12-17' : a < 45 ? '18-44' : a < 65 ? '45-64' : a < 75 ? '65-74' : '75+';
        bands[b] += x.count;
      }
      state.ages[n] = bands;
      save();
      done++;
      if (done % 20 === 0) console.log(`ages ${Object.keys(state.ages).length}/${names.length}`);
      await sleep(300);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
} catch (e) {
  console.error(String(e.message ?? e));
  fs.writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), source: "openFDA (public domain)", partial: true, ...state }));
  process.exit(2);
}
fs.writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), source: 'openFDA (public domain)', ...state }));
console.log(`wrote ${OUT}`);
