/// <reference lib="webworker" />
// RDKit (Emscripten) needs dynamic code generation; it runs here, isolated from the page, under a
// worker-specific CSP served by the backend (see server/src/app.ts).
import initRDKit from '@rdkit/rdkit';

interface Mol {
  get_morgan_fp(o: string): string;
  get_descriptors(): string;
  get_svg(w?: number, h?: number): string;
  is_valid(): boolean;
  delete(): void;
}
let rdkit: Promise<{ get_mol(s: string): Mol | null }> | null = null;

self.onmessage = async (e: MessageEvent<{ id: number; smiles: string }>) => {
  const { id, smiles } = e.data ?? {};
  if (typeof id !== 'number' || typeof smiles !== 'string') return;
  const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
  try {
    rdkit ??= (initRDKit as unknown as (o: { locateFile: () => string }) => Promise<{ get_mol(s: string): Mol | null }>)({ locateFile: () => '/vendor/RDKit_minimal.wasm' });
    const R = await rdkit;
    const s = smiles.trim();
    if (!s || s.length > 500) return post({ id, result: { valid: false } });
    const mol = R.get_mol(s);
    if (!mol || !mol.is_valid()) {
      mol?.delete();
      return post({ id, result: { valid: false } });
    }
    const d = JSON.parse(mol.get_descriptors()) as Record<string, number>;
    const result = {
      valid: true,
      fpBits: mol.get_morgan_fp(JSON.stringify({ radius: 2, nBits: 2048 })),
      svg: mol.get_svg(320, 220),
      mw: d.amw ?? d.exactmw,
      logp: d.CrippenClogP,
      tpsa: d.tpsa,
      hbd: d.NumHBD ?? d.lipinskiHBD,
      hba: d.NumHBA ?? d.lipinskiHBA,
      rotb: d.NumRotatableBonds,
    };
    mol.delete();
    post({ id, result });
  } catch (err) {
    rdkit = null;
    post({ id, error: (err as Error).message });
  }
};
