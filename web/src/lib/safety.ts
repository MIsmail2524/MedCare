import { useEffect, useState } from 'react';
import type { SafetyKB } from '@medcare/engine';

let kbPromise: Promise<SafetyKB> | null = null;

/** Open drug-safety knowledge base (openFDA labels + FAERS + PubChem), served as a static file. */
export function loadSafetyKB(): Promise<SafetyKB> {
  kbPromise ??= fetch('/data/safety-kb.json', { credentials: 'same-origin' }).then((r) => {
    if (!r.ok) throw new Error('Safety knowledge base not available');
    return r.json() as Promise<SafetyKB>;
  });
  kbPromise.catch(() => {
    kbPromise = null;
  });
  return kbPromise;
}

export function useSafetyKB() {
  const [kb, setKb] = useState<SafetyKB | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadSafetyKB().then(setKb).catch((e) => setError((e as Error).message));
  }, []);
  return { kb, error };
}

// --- RDKit (WASM) for structures entered by the user, isolated in a Web Worker
export interface ParsedMolecule {
  valid: boolean;
  error?: string;
  fpBits?: string;
  svg?: string;
  mw?: number;
  logp?: number;
  tpsa?: number;
  hbd?: number;
  hba?: number;
  rotb?: number;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (m: ParsedMolecule) => void; reject: (e: Error) => void }>();
function rdkitWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/rdkit.worker.ts', import.meta.url), { type: 'module', name: 'rdkit' });
  worker.onmessage = (e: MessageEvent<{ id: number; result?: ParsedMolecule; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error) p.reject(new Error(e.data.error));
    else p.resolve(e.data.result!);
  };
  worker.onerror = () => {
    for (const p of pending.values()) p.reject(new Error('Structure engine failed to start'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function parseSmiles(smiles: string): Promise<ParsedMolecule> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    rdkitWorker().postMessage({ id, smiles });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error('Structure engine timed out'));
    }, 30000);
  });
}

export const ORGAN_NAMES: Record<string, string> = {
  liver: 'Liver', kidneys: 'Kidneys', heart: 'Heart / QT', blood: 'Blood & bleeding', skin: 'Skin (SCAR)', brain: 'Nervous system', lungs: 'Lungs / breathing', gi: 'GI tract', pancreas: 'Pancreas / glucose', muscle: 'Muscle & tendon', thyroid: 'Thyroid',
};
