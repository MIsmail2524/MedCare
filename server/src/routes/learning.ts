import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import {
  bayesianEstimate, DRUG_MAP, emptyLearnedModel, getDrug, priorSummary, reinforcePolicy, RL_ACTIONS, RL_ELIGIBLE, RL_STATE_COUNT,
  RL_STATUSES, samplesFromOutcome, serializePolicy, simulate, statusFromMetric, updateAEModel, updatePrior, ORGANS,
  type DosingPolicy, type LearnedModel, type Organ, type Patient, type Regimen, type RLStatus,
} from '@medcare/engine';
import { audit, HttpError, requireAuth } from '../auth.js';
import { isTest } from '../config.js';
import type { DB } from '../db.js';
import { patientSchema, regimenSchema } from '../schemas.js';
import { paramId, parse } from '../validate.js';
import { aiEnabled, explainSimulation } from '../ai.js';

const organ = z.enum(ORGANS as [Organ, ...Organ[]]);
const outcomeSchema = z.object({
  twinId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  patient: patientSchema,
  drugId: z.string().max(40).refine((s) => Object.hasOwn(DRUG_MAP, s), 'Unknown drug'),
  regimens: z.array(regimenSchema).min(1).max(8),
  observations: z.array(z.object({ timeH: z.number().min(0.01).max(24 * 365), value: z.number().min(0).max(1e6) })).max(12).default([]),
  sideEffects: z.array(z.object({ organ, occurred: z.boolean(), severity: z.enum(['mild', 'moderate', 'severe']).optional(), onsetH: z.number().min(0).max(24 * 365).optional() })).max(11).default([]),
  decision: z.object({ prevStatus: z.enum(RL_STATUSES), multiplier: z.number().min(0.1).max(5) }).optional(),
  efficacy: z.enum(['none', 'partial', 'good']).optional(),
  notes: z.string().trim().max(1000).optional(),
});

const finite = z.number().refine(Number.isFinite, 'must be finite');
const policySchema = z.object({
  drugId: z.string().refine((s) => RL_ELIGIBLE.includes(s), 'Drug not eligible for RL dosing'),
  q: z.array(finite.refine((v) => Math.abs(v) < 1000)).length(RL_STATE_COUNT * RL_ACTIONS.length),
  counts: z.array(z.number().int().min(0).max(1e9)).length(RL_STATE_COUNT * RL_ACTIONS.length),
  episodes: z.number().int().min(0).max(1e8),
  realUpdates: z.number().int().min(0).max(1e8),
  trainedAt: z.string().max(40),
  rewardCurve: z.array(finite).max(2000),
  evaluation: z
    .object({
      subjects: z.number().int().min(1).max(100000),
      policy: z.object({ pta: finite, toxic: finite, meanReward: finite }),
      standard: z.object({ pta: finite, toxic: finite, meanReward: finite }),
    })
    .optional(),
});

function loadModel(db: DB, userId: string): LearnedModel {
  const row = db.prepare('SELECT data FROM learned_models WHERE user_id = ?').get(userId) as { data: string } | undefined;
  if (!row) return emptyLearnedModel();
  const m = JSON.parse(row.data) as LearnedModel;
  return { ...emptyLearnedModel(), ...m, priors: Object.assign(Object.create(null), m.priors), policies: Object.assign(Object.create(null), m.policies) };
}
function saveModel(db: DB, userId: string, m: LearnedModel) {
  const data = JSON.stringify({ ...m, updatedAt: new Date().toISOString() });
  db.prepare('INSERT INTO learned_models (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(userId, data, Date.now());
}

export function learningRouter(db: DB) {
  const r = Router();
  const heavy = rateLimit({ windowMs: 60_000, limit: isTest ? 1000 : 20, standardHeaders: 'draft-7', legacyHeaders: false });
  const aiLimiter = rateLimit({ windowMs: 60_000, limit: isTest ? 1000 : 8, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anon' });

  r.get('/learning/model', requireAuth, (req, res) => {
    const m = loadModel(db, req.user!.id);
    res.json({
      model: m,
      priors: Object.fromEntries(Object.entries(m.priors).map(([k, p]) => [k, priorSummary(p)])),
      eligible: RL_ELIGIBLE,
    });
  });

  r.delete('/learning/model', requireAuth, (req, res) => {
    db.prepare('DELETE FROM learned_models WHERE user_id = ?').run(req.user!.id);
    audit(db, req, 'learning.reset');
    res.json({ ok: true });
  });

  r.put('/learning/policies/:drugId', requireAuth, heavy, (req, res) => {
    const drugId = paramId(req.params.drugId);
    const body = parse(policySchema, req.body) as DosingPolicy;
    if (body.drugId !== drugId) throw new HttpError(400, 'Drug mismatch');
    const m = loadModel(db, req.user!.id);
    m.policies[drugId] = serializePolicy(body);
    m.version += 1;
    saveModel(db, req.user!.id, m);
    audit(db, req, 'learning.policy.save', drugId, { episodes: body.episodes });
    res.json({ ok: true });
  });

  r.get('/outcomes', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT id, twin_id, drug_id, data, learned, created_at FROM outcomes WHERE user_id = ? ORDER BY created_at DESC LIMIT 300').all(req.user!.id) as {
      id: string; twin_id: string | null; drug_id: string; data: string; learned: string; created_at: number;
    }[];
    res.json({ outcomes: rows.map((o) => ({ id: o.id, twinId: o.twin_id, drugId: o.drug_id, ...JSON.parse(o.data), learned: JSON.parse(o.learned), createdAt: o.created_at })) });
  });

  r.delete('/outcomes/:id', requireAuth, (req, res) => {
    const out = db.prepare('DELETE FROM outcomes WHERE id = ? AND user_id = ?').run(paramId(req.params.id), req.user!.id);
    if (!out.changes) throw new HttpError(404, 'Outcome not found');
    res.json({ ok: true });
  });

  /** Record an observed clinical outcome and update the user's learned models (server-side, so updates cannot be forged). */
  r.post('/outcomes', requireAuth, heavy, (req, res) => {
    const body = parse(outcomeSchema, req.body);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM outcomes WHERE user_id = ?').get(req.user!.id) as { n: number }).n;
    if (count >= 2000) throw new HttpError(400, 'Outcome limit reached');
    const patient = body.patient as Patient;
    const regimens = body.regimens as Regimen[];
    if (!regimens.some((x) => x.drugId === body.drugId)) throw new HttpError(400, 'Regimen must include the outcome drug');
    if (regimens.reduce((s, x) => s + x.doses, 0) > 4000) throw new HttpError(400, 'Too many doses');
    const drug = getDrug(body.drugId);
    const m = loadModel(db, req.user!.id);
    const learned: Record<string, unknown> = {};

    // 1. Pharmacokinetics: individual MAP estimate → pooled population prior
    let eta = { CL: 0, V: 0, ka: 0 };
    if (body.observations.length && !drug.pk.mm) {
      const fit = bayesianEstimate(patient, regimens, body.drugId, body.observations);
      eta = fit.eta;
      m.priors[body.drugId] = updatePrior(m.priors[body.drugId], fit.eta);
      learned.pk = { clFactor: Math.exp(fit.eta.CL), vFactor: Math.exp(fit.eta.V), pooled: priorSummary(m.priors[body.drugId]) };
    }

    // 2. Side effects: online logistic update of organ risk models
    const sim = simulate({ patient, regimens, etas: { [body.drugId]: eta } });
    if (body.sideEffects.length) {
      const samples = samplesFromOutcome(sim, patient, body.drugId, body.sideEffects);
      m.ae = updateAEModel(m.ae, samples);
      learned.sideEffects = { samples: samples.length, positives: samples.filter((s) => s.label === 1).map((s) => s.organ) };
    }

    // 3. Reinforcement learning: real (state, action, observed exposure) transition
    const policy = m.policies[body.drugId];
    if (policy) {
      const metric = sim.metrics[body.drugId]?.targetValue;
      const observed: RLStatus = body.sideEffects.some((s) => s.occurred && s.severity === 'severe') ? 'toxic' : metric != null ? statusFromMetric(body.drugId, metric) : 'within';
      const base = getDrug(body.drugId).defaultRegimen;
      const reg = regimens.find((x) => x.drugId === body.drugId)!;
      const multiplier = body.decision?.multiplier ?? (reg.unit === base.unit ? reg.dose / base.dose : 1);
      m.policies[body.drugId] = serializePolicy(reinforcePolicy(policy, patient, body.decision?.prevStatus ?? 'none', multiplier, observed));
      learned.policy = { observed, multiplier, realUpdates: m.policies[body.drugId].realUpdates };
    }
    m.outcomes += 1;
    m.version += 1;
    saveModel(db, req.user!.id, m);
    const id = randomUUID();
    const { patient: _p, ...rest } = body;
    void _p;
    db.prepare('INSERT INTO outcomes (id, user_id, twin_id, drug_id, data, learned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, req.user!.id, body.twinId ?? null, body.drugId, JSON.stringify({ ...rest, patientSummary: { age: patient.age, sex: patient.sex, weightKg: patient.weightKg, scr: patient.scr } }), JSON.stringify(learned), Date.now(),
    );
    audit(db, req, 'outcome.record', id, { drug: body.drugId });
    res.status(201).json({ id, learned, modelVersion: m.version });
  });

  // ---- AI explainer
  r.get('/ai/status', requireAuth, (_req, res) => {
    res.json({ enabled: aiEnabled() });
  });

  r.post('/ai/explain', requireAuth, aiLimiter, async (req, res) => {
    if (!aiEnabled()) throw new HttpError(503, 'AI explainer is not configured on this server');
    const { context } = parse(z.object({ context: z.string().min(20).max(16000) }), req.body);
    try {
      const out = await explainSimulation(context);
      audit(db, req, 'ai.explain');
      res.json(out);
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'AI service is busy — try again shortly');
      if (e instanceof Anthropic.AuthenticationError) throw new HttpError(503, 'AI service credentials are invalid');
      if (e instanceof Anthropic.APIError) throw new HttpError(502, 'AI service error');
      throw new HttpError(502, (e as Error).message);
    }
  });

  return r;
}
