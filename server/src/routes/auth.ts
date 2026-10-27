import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { audit, blockDemo, createSession, destroySession, HttpError, issueCsrf, requireAuth, toAuthUser } from '../auth.js';
import { config, isTest } from '../config.js';
import type { DB } from '../db.js';
import { decrypt, encrypt } from '../security/crypto.js';
import { dummyHash, hashPassword, passwordProblems, verifyPassword } from '../security/password.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../security/totp.js';
import { loginSchema, passwordChangeSchema, profileSchema, registerSchema, totpCodeSchema } from '../schemas.js';
import { parse } from '../validate.js';

export function authRouter(db: DB) {
  const r = Router();
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: isTest ? 1000 : 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts, please try again later.' },
  });

  r.get('/csrf', (_req, res) => {
    res.json({ token: issueCsrf(res) });
  });

  r.post('/register', authLimiter, async (req, res) => {
    if (!config.allowRegistration) throw new HttpError(403, 'Registration is disabled');
    const body = parse(registerSchema, req.body);
    const problems = passwordProblems(body.password, body.email);
    if (problems.length) throw new HttpError(400, 'Password does not meet policy', problems.map((m) => ({ path: 'password', message: m })));
    const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(body.email);
    const hash = await hashPassword(body.password);
    if (exists) {
      audit(db, req, 'auth.register.duplicate', body.email);
      throw new HttpError(409, 'An account with this email already exists');
    }
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, email, name, password_hash, role, organisation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, body.email, body.name, hash, body.role, body.organisation ?? null, Date.now(),
    );
    audit(db, req, 'auth.register', id, { role: body.role }, id);
    createSession(db, req, res, id);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as never;
    res.status(201).json({ user: toAuthUser(row) });
  });

  r.post('/login', authLimiter, async (req, res) => {
    const body = parse(loginSchema, req.body);
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email) as
      | { id: string; password_hash: string; failed_attempts: number; locked_until: number; disabled: number; totp_enabled: number; totp_secret: string | null; totp_last_counter: number }
      | undefined;
    const generic = new HttpError(401, 'Invalid email or password');
    if (!row) {
      await verifyPassword(body.password, await dummyHash());
      audit(db, req, 'auth.login.failed', body.email, { reason: 'unknown' });
      throw generic;
    }
    const now = Date.now();
    if (row.locked_until > now) {
      audit(db, req, 'auth.login.locked', row.id, undefined, row.id);
      throw new HttpError(429, 'Account temporarily locked after repeated failed attempts. Try again later.');
    }
    const ok = await verifyPassword(body.password, row.password_hash);
    if (!ok || row.disabled) {
      const fails = row.failed_attempts + 1;
      const lock = fails >= config.maxLoginAttempts ? now + config.lockoutMinutes * 60_000 : 0;
      db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : fails, lock, row.id);
      audit(db, req, 'auth.login.failed', row.id, { reason: row.disabled ? 'disabled' : 'password', locked: !!lock }, row.id);
      throw generic;
    }
    if (row.totp_enabled) {
      if (!body.totp) throw new HttpError(401, 'Two-factor code required', [{ path: 'totp', message: 'required' }]);
      const counter = verifyTotp(decrypt(row.totp_secret!), body.totp, now, row.totp_last_counter);
      if (counter === null) {
        const fails = row.failed_attempts + 1;
        const lock = fails >= config.maxLoginAttempts ? now + config.lockoutMinutes * 60_000 : 0;
        db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : fails, lock, row.id);
        audit(db, req, 'auth.login.failed', row.id, { reason: 'totp' }, row.id);
        throw new HttpError(401, 'Invalid two-factor code', [{ path: 'totp', message: 'invalid' }]);
      }
      db.prepare('UPDATE users SET totp_last_counter = ? WHERE id = ?').run(counter, row.id);
    }
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0, last_login_at = ? WHERE id = ?').run(now, row.id);
    // Session fixation defence: drop any existing session presented with this request.
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(req.sessionHash);
    createSession(db, req, res, row.id);
    audit(db, req, 'auth.login', row.id, undefined, row.id);
    res.json({ user: toAuthUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.id) as never) });
  });

  r.post('/logout', (req, res) => {
    if (req.user) audit(db, req, 'auth.logout');
    destroySession(db, req, res);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    res.json({ user: req.user ?? null });
  });

  r.patch('/profile', requireAuth, blockDemo, (req, res) => {
    const body = parse(profileSchema, req.body);
    db.prepare('UPDATE users SET name = ?, organisation = ? WHERE id = ?').run(body.name, body.organisation ?? null, req.user!.id);
    audit(db, req, 'user.profile.update');
    res.json({ user: toAuthUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as never) });
  });

  r.post('/password', requireAuth, blockDemo, authLimiter, async (req, res) => {
    const body = parse(passwordChangeSchema, req.body);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as { password_hash: string };
    if (!(await verifyPassword(body.currentPassword, row.password_hash))) throw new HttpError(400, 'Current password is incorrect');
    const problems = passwordProblems(body.newPassword, req.user!.email);
    if (problems.length) throw new HttpError(400, 'Password does not meet policy', problems.map((m) => ({ path: 'newPassword', message: m })));
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(body.newPassword), req.user!.id);
    // Revoke every other session.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(req.user!.id, req.sessionHash!);
    audit(db, req, 'auth.password.change');
    res.json({ ok: true });
  });

  r.get('/sessions', requireAuth, (req, res) => {
    const rows = db
      .prepare('SELECT id_hash, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC')
      .all(req.user!.id) as { id_hash: string; created_at: number; last_seen_at: number; ip: string; user_agent: string }[];
    res.json({
      sessions: rows.map((s) => ({ id: s.id_hash.slice(0, 12), current: s.id_hash === req.sessionHash, createdAt: s.created_at, lastSeenAt: s.last_seen_at, ip: s.ip, userAgent: s.user_agent })),
    });
  });

  r.post('/sessions/revoke-others', requireAuth, (req, res) => {
    const n = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(req.user!.id, req.sessionHash!);
    audit(db, req, 'auth.sessions.revoke', undefined, { count: Number(n.changes) });
    res.json({ revoked: Number(n.changes) });
  });

  // --- TOTP two-factor authentication
  r.post('/totp/setup', requireAuth, blockDemo, (req, res) => {
    if (req.user!.totpEnabled) throw new HttpError(400, 'Two-factor authentication is already enabled');
    const secret = generateSecret();
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(encrypt(secret), req.user!.id);
    res.json({ secret, otpauthUrl: otpauthUrl(secret, req.user!.email) });
  });

  r.post('/totp/enable', requireAuth, blockDemo, authLimiter, (req, res) => {
    const { code } = parse(totpCodeSchema, req.body);
    const row = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(req.user!.id) as { totp_secret: string | null };
    if (!row.totp_secret) throw new HttpError(400, 'Start setup first');
    const counter = verifyTotp(decrypt(row.totp_secret), code);
    if (counter === null) throw new HttpError(400, 'Invalid code — check your authenticator time sync');
    db.prepare('UPDATE users SET totp_enabled = 1, totp_last_counter = ? WHERE id = ?').run(counter, req.user!.id);
    audit(db, req, 'auth.totp.enable');
    res.json({ ok: true });
  });

  r.post('/totp/disable', requireAuth, blockDemo, authLimiter, async (req, res) => {
    const body = parse(passwordChangeSchema.pick({ currentPassword: true }), req.body);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as { password_hash: string };
    if (!(await verifyPassword(body.currentPassword, row.password_hash))) throw new HttpError(400, 'Current password is incorrect');
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_counter = 0 WHERE id = ?').run(req.user!.id);
    audit(db, req, 'auth.totp.disable');
    res.json({ ok: true });
  });

  r.delete('/account', requireAuth, blockDemo, async (req, res) => {
    const body = parse(passwordChangeSchema.pick({ currentPassword: true }), req.body);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as { password_hash: string };
    if (!(await verifyPassword(body.currentPassword, row.password_hash))) throw new HttpError(400, 'Current password is incorrect');
    audit(db, req, 'user.delete', req.user!.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.user!.id);
    destroySession(db, req, res);
    res.json({ ok: true });
  });

  return r;
}
