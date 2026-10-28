// Copy runtime WASM assets that package "exports" maps do not expose to bundlers.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const src = path.join(path.dirname(require.resolve('@rdkit/rdkit')), 'RDKit_minimal.wasm');
const dst = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../web/public/vendor/RDKit_minimal.wasm');
fs.mkdirSync(path.dirname(dst), { recursive: true });
if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst);
console.log('vendor: RDKit_minimal.wasm');
