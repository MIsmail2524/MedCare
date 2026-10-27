import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import type { DB } from './db.js';
import { randomToken, sha256 } from './security/crypto.js';

export type Role = 'student' | 'clinician' | 'researcher' | 'admin';
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  organisation: string | null;
  totpEnabled: boolean;
  isDemo: boolean;
  createdAt: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
    sessionHash?: string;
  }
}

export const SESSION_COOKIE = config.cookieSecure ? '__Host-mc_session' : 'mc_session';
export const CSRF_COOKIE = config.cookieSecure ? '__Host-mc_csrf' : 'mc_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function audit(db: DB, req: Request, action: string, target?: string, meta?: Record<string, unknown>, userId?: string) {
  db.prepare('INSERT INTO audit_log (user_id, action, target, ip, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    userId ?? req.user?.id ?? null,
    action,
    target ?? null,
    req.ip ?? null,
    meta ? JSON.stringify(meta) : null,
    Date.now(),
  );
}

export function createSession(db: DB, req: Request, res: Response, userId: string) {
  const token = randomToken(32);
  const now = Date.now();
  const expires = now + config.sessionAbsoluteHours * 3600_000;
  db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    sha256(token),
    userId,
    now,
    now,
    expires,
    req.ip ?? null,
    String(req.get('user-agent') ?? '').slice(0, 200),
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: config.sessionAbsoluteHours * 3600_000,
  });
  // Rotate CSRF token with the new session.
  issueCsrf(res);
}

export function destroySession(db: DB, req: Request, res: Response) {
  if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(req.sessionHash);
  res.clearCookie(SESSION_COOKIE, { path: '/', secure: config.cookieSecure, sameSite: 'strict', httpOnly: true });
}

export function issueCsrf(res: Response): string {
  const token = randomToken(24);
  res.cookie(CSRF_COOKIE, token, { httpOnly: false, secure: config.cookieSecure, sameSite: 'strict', path: '/' });
  return token;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  organisation: string | null;
  totp_enabled: number;
  is_demo: number;
  disabled: number;
  created_at: number;
}

export function toAuthUser(r: UserRow): AuthUser {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    organisation: r.organisation,
    totpEnabled: !!r.totp_enabled,
    isDemo: !!r.is_demo,
    createdAt: r.created_at,
  };
}

/** Resolve the session cookie into `req.user` (sliding idle timeout, absolute expiry). */
export function sessionMiddleware(db: DB) {
  const find = db.prepare(
    `SELECT s.id_hash, s.last_seen_at, s.expires_at, u.id, u.email, u.name, u.role, u.organisation, u.totp_enabled, u.is_demo, u.disabled, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
  );
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?');
  const del = db.prepare('DELETE FROM sessions WHERE id_hash = ?');
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && token.length >= 20 && token.length <= 100) {
      const hash = sha256(token);
      const row = find.get(hash) as (UserRow & { id_hash: string; last_seen_at: number; expires_at: number }) | undefined;
      const now = Date.now();
      if (row) {
        const idle = now - row.last_seen_at > config.sessionIdleMinutes * 60_000;
        if (row.disabled || idle || now > row.expires_at) {
          del.run(hash);
        } else {
          if (now - row.last_seen_at > 60_000) touch.run(now, hash);
          req.user = toAuthUser(row);
          req.sessionHash = hash;
        }
      }
    }
    next();
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'Authentication required'));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, 'Insufficient permissions'));
    next();
  };
}

/** Demo accounts are shared publicly: block account-level changes. */
export function blockDemo(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.isDemo) return next(new HttpError(403, 'This action is disabled for the shared demo account'));
  next();
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth: SameSite=Strict cookies + double-submit token + Origin verification
 * for every state-changing request.
 */
export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (SAFE.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    const host = req.get('host');
    let ok = false;
    try {
      const u = new URL(origin);
      ok = u.host === host || config.allowedOrigins.includes(u.origin);
    } catch {
      ok = false;
    }
    if (!ok) return next(new HttpError(403, 'Cross-origin request blocked'));
  }
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get(CSRF_HEADER);
  if (typeof cookie !== 'string' || typeof header !== 'string' || cookie.length < 16 || cookie.length !== header.length) {
    return next(new HttpError(403, 'Invalid CSRF token'));
  }
  if (!timingSafeEqual(Buffer.from(cookie), Buffer.from(header))) return next(new HttpError(403, 'Invalid CSRF token'));
  next();
}
