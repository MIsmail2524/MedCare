import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import {
  DRUGS, PROCEDURES, TRAINING_CASES, derivePhysiology, evaluateAlerts, recommendDose, scoreCase, simulate,
} from '@medcare/engine';
import { audit, HttpError, requireAuth, requireRole } from '../auth.js';
import { isTest } from '../config.js';
import type { DB } from '../db.js';
import { adminUserPatch, attemptSchema, compoundSchema, savedSimulationSchema, simulateSchema, twinSchema } from '../schemas.js';
import { paramId, parse } from '../validate.js';

const MAX_TWINS = 200;
const MAX_SIMS = 500;
const MAX_COMPOUNDS = 200;

export function dataRouter(db: DB) {
  const r = Router();

  // ---------- public reference data
  r.get('/drugs', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ drugs: DRUGS, procedures: PROCEDURES });
  });

  // ---------- server-side simulation API (bounded CPU)
  const simLimiter = rateLimit({ windowMs: 60_000, limit: isTest ? 1000 : 30, standardHeaders: 'draft-7', legacyHeaders: false });
  r.post('/simulate', requireAuth, simLimiter, (req, res) => {
    const body = parse(simulateSchema, req.body);
    const total = body.regimens.reduce((s, x) => s + x.doses, 0);
    if (total > 4000) throw new HttpError(400, 'Too many doses');
    const phys = derivePhysiology(body.patient);
    const sim = simulate({ patient: body.patient, physiology: phys, regimens: body.regimens, durationH: body.durationH });
    const ids = sim.drugIds;
    res.json({
      t: sim.t,
      series: sim.series,
      qtc: sim.qtc,
      metrics: sim.metrics,
      physiology: phys,
      alerts: evaluateAlerts(body.patient, phys, ids, sim),
      recommendations: ids.map((id) => recommendDose(body.patient, body.regimens, id)).filter(Boolean),
    });
  });

  // ---------- twins
  r.get('/twins', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT id, name, data, created_at, updated_at FROM twins WHERE user_id = ? ORDER BY updated_at DESC').all(req.user!.id) as {
      id: string; name: string; data: string; created_at: number; updated_at: number;
    }[];
    res.json({ twins: rows.map((t) => ({ id: t.id, name: t.name, data: JSON.parse(t.data), createdAt: t.created_at, updatedAt: t.updated_at })) });
  });

  r.get('/twins/:id', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM twins WHERE id = ? AND user_id = ?').get(paramId(req.params.id), req.user!.id) as
      | { id: string; name: string; data: string; created_at: number; updated_at: number }
      | undefined;
    if (!row) throw new HttpError(404, 'Twin not found');
    res.json({ twin: { id: row.id, name: row.name, data: JSON.parse(row.data), createdAt: row.created_at, updatedAt: row.updated_at } });
  });

  r.post('/twins', requireAuth, (req, res) => {
    const body = parse(twinSchema, req.body);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM twins WHERE user_id = ?').get(req.user!.id) as { n: number }).n;
    if (count >= MAX_TWINS) throw new HttpError(400, `Limit of ${MAX_TWINS} twins reached`);
    const id = randomUUID();
    const now = Date.now();
    db.prepare('INSERT INTO twins (id, user_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.user!.id, body.name, JSON.stringify(body.data), now, now);
    audit(db, req, 'twin.create', id);
    res.status(201).json({ twin: { id, name: body.name, data: body.data, createdAt: now, updatedAt: now } });
  });

  r.put('/twins/:id', requireAuth, (req, res) => {
    const id = paramId(req.params.id);
    const body = parse(twinSchema, req.body);
    const now = Date.now();
    const out = db.prepare('UPDATE twins SET name = ?, data = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(body.name, JSON.stringify(body.data), now, id, req.user!.id);
    if (!out.changes) throw new HttpError(404, 'Twin not found');
    audit(db, req, 'twin.update', id);
    res.json({ twin: { id, name: body.name, data: body.data, updatedAt: now } });
  });

  r.delete('/twins/:id', requireAuth, (req, res) => {
    const id = paramId(req.params.id);
    const out = db.prepare('DELETE FROM twins WHERE id = ? AND user_id = ?').run(id, req.user!.id);
    if (!out.changes) throw new HttpError(404, 'Twin not found');
    audit(db, req, 'twin.delete', id);
    res.json({ ok: true });
  });

  // ---------- saved simulations / experiments
  r.get('/simulations', requireAuth, (req, res) => {
    const rows = db
      .prepare('SELECT id, twin_id, name, kind, summary, created_at FROM simulations WHERE user_id = ? ORDER BY created_at DESC LIMIT 200')
      .all(req.user!.id) as { id: string; twin_id: string | null; name: string; kind: string; summary: string; created_at: number }[];
    res.json({ simulations: rows.map((s) => ({ id: s.id, twinId: s.twin_id, name: s.name, kind: s.kind, summary: JSON.parse(s.summary), createdAt: s.created_at })) });
  });

  r.get('/simulations/:id', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM simulations WHERE id = ? AND user_id = ?').get(paramId(req.params.id), req.user!.id) as
      | { id: string; twin_id: string | null; name: string; kind: string; config: string; summary: string; created_at: number }
      | undefined;
    if (!row) throw new HttpError(404, 'Simulation not found');
    res.json({ simulation: { id: row.id, twinId: row.twin_id, name: row.name, kind: row.kind, config: JSON.parse(row.config), summary: JSON.parse(row.summary), createdAt: row.created_at } });
  });

  r.post('/simulations', requireAuth, (req, res) => {
    const body = parse(savedSimulationSchema, req.body);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM simulations WHERE user_id = ?').get(req.user!.id) as { n: number }).n;
    if (count >= MAX_SIMS) throw new HttpError(400, `Limit of ${MAX_SIMS} saved experiments reached — delete older ones`);
    if (body.twinId && !db.prepare('SELECT 1 FROM twins WHERE id = ? AND user_id = ?').get(body.twinId, req.user!.id)) throw new HttpError(400, 'Unknown twin');
    const id = randomUUID();
    const now = Date.now();
    db.prepare('INSERT INTO simulations (id, user_id, twin_id, name, kind, config, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, req.user!.id, body.twinId ?? null, body.name, body.kind, JSON.stringify(body.config), JSON.stringify(body.summary), now,
    );
    audit(db, req, 'simulation.save', id, { kind: body.kind });
    res.status(201).json({ simulation: { id, name: body.name, kind: body.kind, createdAt: now } });
  });

  r.delete('/simulations/:id', requireAuth, (req, res) => {
    const id = paramId(req.params.id);
    const out = db.prepare('DELETE FROM simulations WHERE id = ? AND user_id = ?').run(id, req.user!.id);
    if (!out.changes) throw new HttpError(404, 'Simulation not found');
    audit(db, req, 'simulation.delete', id);
    res.json({ ok: true });
  });

  // ---------- compounds (drug discovery sandbox)
  r.get('/compounds', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT id, name, data, updated_at FROM compounds WHERE user_id = ? ORDER BY updated_at DESC').all(req.user!.id) as {
      id: string; name: string; data: string; updated_at: number;
    }[];
    res.json({ compounds: rows.map((c) => ({ id: c.id, name: c.name, data: JSON.parse(c.data), updatedAt: c.updated_at })) });
  });

  r.post('/compounds', requireAuth, (req, res) => {
    const body = parse(compoundSchema, req.body);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM compounds WHERE user_id = ?').get(req.user!.id) as { n: number }).n;
    if (count >= MAX_COMPOUNDS) throw new HttpError(400, 'Compound limit reached');
    const id = randomUUID();
    const now = Date.now();
    db.prepare('INSERT INTO compounds (id, user_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.user!.id, body.name, JSON.stringify(body), now, now);
    audit(db, req, 'compound.create', id);
    res.status(201).json({ compound: { id, name: body.name, data: body, updatedAt: now } });
  });

  r.put('/compounds/:id', requireAuth, (req, res) => {
    const id = paramId(req.params.id);
    const body = parse(compoundSchema, req.body);
    const now = Date.now();
    const out = db.prepare('UPDATE compounds SET name = ?, data = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(body.name, JSON.stringify(body), now, id, req.user!.id);
    if (!out.changes) throw new HttpError(404, 'Compound not found');
    res.json({ compound: { id, name: body.name, data: body, updatedAt: now } });
  });

  r.delete('/compounds/:id', requireAuth, (req, res) => {
    const id = paramId(req.params.id);
    const out = db.prepare('DELETE FROM compounds WHERE id = ? AND user_id = ?').run(id, req.user!.id);
    if (!out.changes) throw new HttpError(404, 'Compound not found');
    audit(db, req, 'compound.delete', id);
    res.json({ ok: true });
  });

  // ---------- training (server-side scoring so stored results cannot be forged)
  r.get('/training/attempts', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT id, case_id, score, total, created_at FROM training_attempts WHERE user_id = ? ORDER BY created_at DESC LIMIT 500').all(req.user!.id) as {
      id: string; case_id: string; score: number; total: number; created_at: number;
    }[];
    res.json({ attempts: rows.map((a) => ({ id: a.id, caseId: a.case_id, score: a.score, total: a.total, createdAt: a.created_at })) });
  });

  r.post('/training/attempts', requireAuth, (req, res) => {
    const body = parse(attemptSchema, req.body);
    if (!TRAINING_CASES.some((c) => c.id === body.caseId)) throw new HttpError(400, 'Unknown case');
    for (const k of Object.keys(body.answers)) if (!/^q\d{1,2}$/.test(k)) throw new HttpError(400, 'Invalid answer key');
    const result = scoreCase(body.caseId, body.answers);
    const id = randomUUID();
    db.prepare('INSERT INTO training_attempts (id, user_id, case_id, score, total, answers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, req.user!.id, body.caseId, result.score, result.total, JSON.stringify(body.answers), Date.now(),
    );
    res.status(201).json({ attempt: { id, caseId: body.caseId, ...result } });
  });

  r.get('/training/leaderboard', requireAuth, (_req, res) => {
    const rows = db
      .prepare(
        `SELECT u.name AS name, SUM(best.score) AS score, SUM(best.total) AS total, COUNT(*) AS cases FROM (
           SELECT user_id, case_id, MAX(score) AS score, MAX(total) AS total FROM training_attempts GROUP BY user_id, case_id
         ) best JOIN users u ON u.id = best.user_id GROUP BY best.user_id ORDER BY score DESC, cases DESC LIMIT 10`,
      )
      .all() as { name: string; score: number; total: number; cases: number }[];
    // Only expose first name + initial for privacy.
    res.json({ leaders: rows.map((l) => ({ name: l.name.split(/\s+/).map((p, i) => (i === 0 ? p : `${p[0]}.`)).join(' '), score: l.score, total: l.total, cases: l.cases })) });
  });

  // ---------- dashboard stats
  r.get('/stats', requireAuth, (req, res) => {
    const q = (sql: string) => (db.prepare(sql).get(req.user!.id) as { n: number }).n;
    res.json({
      twins: q('SELECT COUNT(*) AS n FROM twins WHERE user_id = ?'),
      simulations: q('SELECT COUNT(*) AS n FROM simulations WHERE user_id = ?'),
      compounds: q('SELECT COUNT(*) AS n FROM compounds WHERE user_id = ?'),
      attempts: q('SELECT COUNT(*) AS n FROM training_attempts WHERE user_id = ?'),
    });
  });

  // ---------- admin
  r.get('/admin/users', requireRole('admin'), (_req, res) => {
    const rows = db
      .prepare('SELECT id, email, name, role, organisation, totp_enabled, disabled, is_demo, created_at, last_login_at, locked_until FROM users ORDER BY created_at DESC LIMIT 1000')
      .all();
    res.json({ users: rows });
  });

  r.patch('/admin/users/:id', requireRole('admin'), (req, res) => {
    const id = paramId(req.params.id);
    const body = parse(adminUserPatch, req.body);
    if (id === req.user!.id && (body.role && body.role !== 'admin' || body.disabled)) throw new HttpError(400, 'You cannot demote or disable your own account');
    const row = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'User not found');
    if (body.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, id);
    if (body.disabled !== undefined) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, id);
      if (body.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    audit(db, req, 'admin.user.update', id, body);
    res.json({ ok: true });
  });

  r.get('/admin/audit', requireRole('admin'), (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = db
      .prepare(
        `SELECT a.id, a.action, a.target, a.ip, a.meta, a.created_at, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         WHERE a.id < ? ORDER BY a.id DESC LIMIT ?`,
      )
      .all(before, limit);
    res.json({ events: rows });
  });

  return r;
}
