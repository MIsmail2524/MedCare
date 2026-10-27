/// <reference lib="webworker" />
import { runTrial, type PopulationSpec, type TrialArm } from '@medcare/engine';

self.onmessage = (e: MessageEvent<{ spec: PopulationSpec; arms: TrialArm[]; drugId: string }>) => {
  // Dedicated worker: messages can only come from the page that created it; still validate shape.
  if (!e.data || !Array.isArray(e.data.arms) || typeof e.data.drugId !== 'string') return;
  const { spec, arms, drugId } = e.data;
  try {
    const results = runTrial(spec, arms, drugId, undefined, (f) => (self as unknown as Worker).postMessage({ type: 'progress', value: f }));
    (self as unknown as Worker).postMessage({ type: 'done', results });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', message: (err as Error).message });
  }
};
