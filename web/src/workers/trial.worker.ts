/// <reference lib="webworker" />
import { runTrial, type PopulationSpec, type TrialArm } from '@medcare/engine';

self.onmessage = (e: MessageEvent<{ spec: PopulationSpec; arms: TrialArm[]; drugId: string }>) => {
  const { spec, arms, drugId } = e.data;
  try {
    const results = runTrial(spec, arms, drugId, undefined, (f) => (self as unknown as Worker).postMessage({ type: 'progress', value: f }));
    (self as unknown as Worker).postMessage({ type: 'done', results });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', message: (err as Error).message });
  }
};
