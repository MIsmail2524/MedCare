import { randomBytes } from 'node:crypto';

const env = process.env;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test' || !!env.VITEST;

function secret(): string {
  const s = env.APP_SECRET;
  if (s && s.length >= 32) return s;
  if (isProd) throw new Error('APP_SECRET must be set to at least 32 characters in production');
  // Development fallback: random per process (sessions/TOTP secrets reset on restart).
  return randomBytes(32).toString('hex');
}

export const config = {
  port: Number(env.PORT ?? 8080),
  host: env.HOST ?? '0.0.0.0',
  databasePath: env.DATABASE_PATH ?? (isTest ? ':memory:' : 'medcare.db'),
  appSecret: secret(),
  /** Secure cookies (HTTPS only). Enabled by default in production. */
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
  /** Number of reverse-proxy hops to trust for client IP (e.g. 1 behind a load balancer). */
  trustProxy: Number(env.TRUST_PROXY ?? 0),
  sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES ?? 120),
  sessionAbsoluteHours: Number(env.SESSION_ABSOLUTE_HOURS ?? 12),
  maxLoginAttempts: 5,
  lockoutMinutes: 15,
  allowRegistration: env.ALLOW_REGISTRATION !== 'false',
  /** Comma-separated extra origins allowed for state-changing requests (e.g. dev server). */
  allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  staticDir: env.STATIC_DIR,
};
