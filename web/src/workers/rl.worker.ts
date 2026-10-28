/// <reference lib="webworker" />
import { evaluatePolicy, trainDosingPolicy, type DosingPolicy } from '@medcare/engine';

interface Msg {
  drugId: string;
  episodes: number;
  start: DosingPolicy | null;
  seed: number;
}

self.onmessage = (e: MessageEvent<Msg>) => {
  // Dedicated worker: only the creating page can post; still validate the payload shape.
  const d = e.data;
  if (!d || typeof d.drugId !== 'string' || typeof d.episodes !== 'number') return;
  const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
  try {
    const policy = trainDosingPolicy(d.drugId, d.start, {
      episodes: Math.min(Math.max(Math.round(d.episodes), 50), 5000),
      seed: d.seed,
      onProgress: (fraction, meanReward) => post({ type: 'progress', fraction, meanReward }),
    });
    post({ type: 'evaluating' });
    policy.evaluation = evaluatePolicy(policy, 80);
    post({ type: 'done', policy });
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
};
