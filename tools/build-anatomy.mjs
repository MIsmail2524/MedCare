#!/usr/bin/env node
// Build web/public/models/anatomy.glb from BodyParts3D OBJ meshes.
//
// Data: BodyParts3D, © The Database Center for Life Science, licensed under CC Attribution 4.0
// International (https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html).
//
// Usage: node tools/build-anatomy.mjs <dir-with-obj-files> [parts-list.txt] [out.glb]
// The parts list (partof_element_parts.txt) maps file ids (FJxxxx) to anatomical names; when it is
// absent the OBJ header comments are used.
import fs from 'node:fs';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, quantize, weld, prune, join, flatten } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const [, , srcDir, partsList, outArg] = process.argv;
if (!srcDir) {
  console.error('usage: node tools/build-anatomy.mjs <obj-dir> [parts-list] [out.glb]');
  process.exit(1);
}
const out = outArg ?? path.resolve('web/public/models/anatomy.glb');

// Organ groups used by the digital twin (plus display-only skeleton layer).
const GROUPS = [
  ['skin', /^skin$/i],
  ['ignore', /hair/i],
  ['brain', /brain|cerebr|cerebell|pons|medulla oblongata|midbrain|thalam|hippocamp|corpus callosum|spinal cord|gyrus|insula|internal capsule|colliculus|habenula|tuber cinereum|pineal|pituitary|(frontal|parietal|temporal|occipital|limbic) lobe|caudate|putamen|globus pallidus|amygdala|claustrum|fornix|mammillary|(lateral|third|fourth) ventricle|lobule|septum pellucidum|olfactory|optic chiasm|cuneus|precuneus|lingual gyrus|operculum|uncus/i],
  ['thyroid', /thyroid gland|thyroid lobe|isthmus of thyroid/i],
  ['heart', /heart|atrium|ventricle|myocard|cardiac|pericard|mitral|tricuspid|valve|cusp/i],
  ['lungs', /lung|bronch|trachea|lobe of (right|left) lung|pleura/i],
  ['liver', /liver|hepatic lobe|gallbladder|gall bladder|bile duct|hepatic duct|cystic duct/i],
  ['pancreas', /pancrea/i],
  ['stomach', /stomach/i],
  ['esophagus', /esophag|oesophag/i],
  ['gi', /intestin|duodenum|jejunum|ileum|ileocecal|colon|rectum|cecum|caecum|appendix|taenia|anal canal/i],
  ['bladder', /urinary bladder|urethra/i],
  ['kidneys', /kidney|renal|ureter|adrenal|suprarenal/i],
  ['blood', /arter|aort|vein|vena|venous|spleen|sinus of dura|coronary sinus|pulmonary trunk|trunk|plantar arch|palmar arch/i],
  ['muscle', /muscle|tendon|diaphragm|brachii|brachialis|brachioradialis|femoris|maximus|medius|minimus|oblique|rectus|deltoid|trapezius|latissimus|pectoralis|gastrocnemius|soleus|sartorius|gracilis|adductor|abductor|flexor|extensor|vastus|psoas|iliacus|serratus|rhomboid|teres|spinatus|subscapularis|masseter|temporalis|buccinator|platysma|sternocleidomastoid|scalen|intercostal|transversus|quadratus|piriformis|gemellus|obturator|tibialis|peroneus|fibularis|popliteus|plantaris|pronator|supinator|coracobrachialis|triceps|biceps|levator|depressor|zygomaticus|orbicularis|corrugator|risorius|mentalis|nasalis|procerus|frontalis|occipitalis|occipitofrontalis|semitendinosus|semimembranosus|pectineus|tensor|multifidus|erector|spinalis|longissimus|iliocostalis|splenius|semispinalis|rotatores|interspinal|digastric|hyoid|sternothyroid|lumbrical|interosse|opponens|palmaris|hallucis|digitorum|pollicis|indicis|minimi|anconeus|subclavius|pterygoid|sphincter|constrictor|stylo|genio|glosso|palato|aryten|cricothyroid|vocalis|longus colli|longus capitis/i],
  ['skeleton', /bone|vertebra|rib|skull|cranium|mandible|maxilla|femur|tibia|fibula|humerus|radius|ulna|pelvi|sacrum|coccyx|scapula|clavicle|sternum|patella|carpal|tarsal|phalan|ilium|ischium|pubis|cartilage|hyoid|atlas|axis|ethmoid|sphenoid|occipital bone|frontal bone|parietal bone|temporal bone|zygomatic|nasal bone|vomer|lacrimal bone|palatine bone|calcaneus|talus|navicular|cuboid|cuneiform|capitate|hamate|lunate|pisiform|scaphoid|trapezium|trapezoid|triquetral|manubrium|xiphoid|metacarp|metatars|sesamoid|coccyg/i],
];

// Visible-only structures (eyes, teeth, tongue, glands …) that have no organ semantics in the twin.
const OTHER = /eye|cornea|iris|lens|sclera|choroid|retina|vitreous|lacrimal|gingiva|tooth|teeth|incisor|canine|premolar|molar|tongue|palat|lip|nasal|larynx|pharynx|epiglott|salivary|parotid|submandibular|sublingual|prostate|testis|ovary|uter|vagina|penis|seminal|ductus|tonsil|thymus|lymph|breast|mammary|ear|cochlea|tympan|nerve|ganglion|ligament|fascia|meniscus|disc|bursa|cartilage|joint|aponeurosis/i;

function groupFor(name) {
  for (const [g, re] of GROUPS) if (re.test(name)) return g;
  if (OTHER.test(name)) return 'other';
  return null;
}

// --- names
const names = new Map();
if (partsList && fs.existsSync(partsList)) {
  for (const line of fs.readFileSync(partsList, 'utf8').split(/\r?\n/).slice(1)) {
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    // columns: concept_id (FMA), representation_id/name ... element file id
    const fj = cols.find((c) => /^FJ\d+$/.test(c.trim()));
    const nm = cols.find((c) => /[a-z]{3,}/i.test(c) && !/^FMA\d+$/.test(c.trim()) && !/^FJ\d+$/.test(c.trim()));
    if (fj && nm) names.set(fj.trim(), nm.trim());
  }
}

// --- minimal OBJ reader (v / vn / f with triangle fan)
function readObj(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const v = [];
  const idx = [];
  let header = '';
  for (const line of txt.split('\n')) {
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      v.push(+p[1], +p[2], +p[3]);
    } else if (line.startsWith('f ')) {
      const p = line.trim().split(/\s+/).slice(1).map((s) => parseInt(s.split('/')[0], 10) - 1);
      for (let i = 1; i + 1 < p.length; i++) idx.push(p[0], p[i], p[i + 1]);
    } else if (line.startsWith('#') && header.length < 2000) header += line + '\n';
  }
  return { v: new Float32Array(v), idx: new Uint32Array(idx), header };
}

function nameFromHeader(header) {
  const m = /#[ \t]*English name[ \t]*:[ \t]*([^\r\n]+)/i.exec(header);
  return m ? m[1].trim() : '';
}

// --- collect
const files = fs.readdirSync(srcDir, { recursive: true }).filter((f) => String(f).toLowerCase().endsWith('.obj')).map((f) => path.join(srcDir, String(f)));
console.log(`OBJ files: ${files.length}`);
const byGroup = new Map();
let unnamed = 0;
const unmapped = new Map();
for (const f of files) {
  const id = path.basename(f, path.extname(f));
  const mesh = readObj(f);
  const nm = names.get(id) ?? nameFromHeader(mesh.header);
  if (!nm) unnamed++;
  const g = groupFor(nm);
  if (g === 'ignore') continue;
  if (!g) {
    unmapped.set(nm || id, (unmapped.get(nm || id) ?? 0) + 1);
    continue;
  }
  if (!byGroup.has(g)) byGroup.set(g, []);
  byGroup.get(g).push({ id, name: nm, ...mesh });
}
console.log(`unnamed: ${unnamed}; unmapped kinds: ${unmapped.size}`);
console.log([...unmapped.entries()].slice(0, 40).map(([k, n]) => `${k}×${n}`).join(' | '));

// --- global bounds → normalise to y-up, 1.8 units tall, centred (feet at -0.9)
let min = [Infinity, Infinity, Infinity];
let max = [-Infinity, -Infinity, -Infinity];
for (const parts of byGroup.values()) for (const p of parts) for (let i = 0; i < p.v.length; i += 3) for (let a = 0; a < 3; a++) {
  min[a] = Math.min(min[a], p.v[i + a]);
  max[a] = Math.max(max[a], p.v[i + a]);
}
const ext = max.map((m, i) => m - min[i]);
const up = ext.indexOf(Math.max(...ext));
console.log('bounds', min.map((x) => x.toFixed(0)), max.map((x) => x.toFixed(0)), 'up axis', 'xyz'[up]);
const scale = 1.8 / ext[up];
const centre = min.map((m, i) => m + ext[i] / 2);

// Determine anterior direction from heart vs. vertebrae (heart is anterior).
const centroid = (parts) => {
  const c = [0, 0, 0];
  let n = 0;
  for (const p of parts ?? []) for (let i = 0; i < p.v.length; i += 3) {
    c[0] += p.v[i];
    c[1] += p.v[i + 1];
    c[2] += p.v[i + 2];
    n++;
  }
  return c.map((x) => x / Math.max(n, 1));
};
const heartC = centroid(byGroup.get('heart'));
const spine = (byGroup.get('skeleton') ?? []).filter((p) => /vertebra/i.test(p.name));
const spineC = centroid(spine.length ? spine : byGroup.get('skeleton'));
const horiz = [0, 1, 2].filter((a) => a !== up);
const depthAxis = horiz.reduce((best, a) => (Math.abs(heartC[a] - spineC[a]) > Math.abs(heartC[best] - spineC[best]) ? a : best), horiz[0]);
const latAxis = horiz.find((a) => a !== depthAxis);
const frontSign = Math.sign(heartC[depthAxis] - spineC[depthAxis]) || 1;
// Patient's left is +x when viewed from the front (heart sits slightly left).
const leftSign = Math.sign(heartC[latAxis] - spineC[latAxis]) || 1;
console.log(`depth axis ${'xyz'[depthAxis]} front ${frontSign}, lateral ${'xyz'[latAxis]} left ${leftSign}`);

function transform(v) {
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    // viewer faces +z; patient's left appears on viewer's right (+x)
    o[i] = (v[i + latAxis] - centre[latAxis]) * scale * leftSign;
    o[i + 1] = (v[i + up] - centre[up]) * scale;
    o[i + 2] = (v[i + depthAxis] - centre[depthAxis]) * scale * frontSign;
  }
  return o;
}

// --- build glTF
const doc = new Document();
doc.createBuffer();
const scene = doc.createScene('anatomy');
const COLORS = {
  brain: [0.91, 0.64, 0.72], thyroid: [0.85, 0.48, 0.42], heart: [0.85, 0.33, 0.31], lungs: [0.89, 0.6, 0.65], liver: [0.61, 0.24, 0.18],
  pancreas: [0.89, 0.72, 0.47], gi: [0.9, 0.65, 0.51], stomach: [0.92, 0.6, 0.5], esophagus: [0.88, 0.58, 0.5], bladder: [0.95, 0.8, 0.45], kidneys: [0.64, 0.26, 0.23], blood: [0.75, 0.22, 0.17], muscle: [0.71, 0.32, 0.29], skeleton: [0.93, 0.9, 0.82], other: [0.85, 0.72, 0.68], skin: [0.87, 0.72, 0.62],
};
// Target fraction of triangles kept per group (vessels/skeleton/muscle are display layers).
const KEEP = { blood: 0.08, skeleton: 0.1, muscle: 0.08, other: 0.1, brain: 0.15, skin: 0.12, heart: 0.4, gi: 0.35, lungs: 0.35, kidneys: 0.6, pancreas: 0.5 };
const summary = {};
const tri = {};
await MeshoptSimplifier.ready;
for (const [g, parts] of byGroup) {
  const mat = doc.createMaterial(g).setBaseColorFactor([...(COLORS[g] ?? [0.8, 0.7, 0.65]), 1]).setRoughnessFactor(0.55).setMetallicFactor(0);
  const groupNode = doc.createNode(g).setExtras({ organ: g });
  scene.addChild(groupNode);
  for (const p of parts) {
    if (!p.idx.length) continue;
    const pos = transform(p.v);
    const keep = KEEP[g] ?? 0.7;
    let idx = p.idx;
    if (idx.length > 600) {
      const target = Math.max(120, Math.floor((idx.length * keep) / 3) * 3);
      const [simplified] = MeshoptSimplifier.simplify(idx, pos, 3, target, 0.01, []);
      if (simplified.length >= 36) idx = simplified;
    }
    tri[g] = (tri[g] ?? [0, 0]);
    tri[g][0] += p.idx.length / 3;
    tri[g][1] += idx.length / 3;
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(idx))
      .setMaterial(mat);
    const mesh = doc.createMesh(p.id).addPrimitive(prim);
    groupNode.addChild(doc.createNode(p.id).setMesh(mesh).setExtras({ organ: g, part: p.name }));
  }
  summary[g] = parts.length;
}
console.log('parts per group', summary);
console.log('triangles before→after', Object.fromEntries(Object.entries(tri).map(([k, [a, b]]) => [k, `${Math.round(a / 1000)}k→${Math.round(b / 1000)}k`])));

await doc.transform(
  weld(),
  dedup(),
  flatten(),
  join({ keepNamed: false }),
  quantize({ quantizePosition: 14 }),
  prune(),
);
fs.mkdirSync(path.dirname(out), { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
await io.write(out, doc);
console.log(`wrote ${out} ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`);
