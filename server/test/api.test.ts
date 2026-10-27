import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { defaultPatient, TRAINING_CASES } from '@medcare/engine';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { ensureSeed } from '../src/seed.js';
import { hotp } from '../src/security/totp.js';
import { hashPassword } from '../src/security/password.js';

const db = openDb(':memory:');
const app = createApp(db);

type Agent = ReturnType<typeof request.agent>;
interface Client {
  agent: Agent;
  csrf: string;
}

async function client(): Promise<Client> {
  const agent = request.agent(app);
  const r = await agent.get('/api/auth/csrf');
  return { agent, csrf: r.body.token };
}
function send(c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown) {
  return c.agent[method](url).set('x-csrf-token', c.csrf).set('content-type', 'application/json').send(JSON.stringify(body ?? {}));
}
async function registered(email: string, password = 'correct-horse-battery'): Promise<Client> {
  const c = await client();
  const r = await send(c, 'post', '/api/auth/register', { email, name: 'Test User', password, role: 'clinician' });
  expect(r.status).toBe(201);
  // CSRF cookie is rotated on login/registration
  const cookies = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
  const csrf = cookies.find((x) => x.startsWith('mc_csrf='));
  if (csrf) c.csrf = csrf.split(';')[0].split('=')[1];
  return c;
}

const twin = (name = 'Twin A') => ({ name, data: defaultPatient({ name }) });

beforeAll(async () => {
  await ensureSeed(db);
});

describe('health & headers', () => {
  it('serves security headers', async () => {
    const r = await request(app).get('/api/health');
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
  });
  it('returns JSON 404 for unknown API routes', async () => {
    const r = await request(app).get('/api/nope');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Not found');
  });
});

describe('authentication', () => {
  it('registers, reads /me, logs out', async () => {
    const c = await registered('alice@example.com');
    const me = await c.agent.get('/api/auth/me');
    expect(me.body.user.email).toBe('alice@example.com');
    expect(me.body.user).not.toHaveProperty('password_hash');
    await send(c, 'post', '/api/auth/logout');
    expect((await c.agent.get('/api/auth/me')).body.user).toBeNull();
  });

  it('sets hardened session cookie', async () => {
    const c = await client();
    const r = await send(c, 'post', '/api/auth/register', { email: 'cookie@example.com', name: 'C', password: 'correct-horse-battery' });
    const cookie = ([] as string[]).concat(r.headers['set-cookie']).find((x) => x.startsWith('mc_session='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('enforces password policy', async () => {
    const c = await client();
    const r = await send(c, 'post', '/api/auth/register', { email: 'weak@example.com', name: 'W', password: 'password1' });
    expect(r.status).toBe(400);
  });

  it('does not allow self-registration as admin', async () => {
    const c = await client();
    const r = await send(c, 'post', '/api/auth/register', { email: 'evil@example.com', name: 'E', password: 'correct-horse-battery', role: 'admin' });
    expect(r.status).toBe(400);
  });

  it('uses a generic error for unknown users and wrong passwords', async () => {
    const c = await client();
    const a = await send(c, 'post', '/api/auth/login', { email: 'nobody@example.com', password: 'whatever-123' });
    const b = await send(c, 'post', '/api/auth/login', { email: 'alice@example.com', password: 'wrong-password-1' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error).toBe(b.body.error);
  });

  it('locks the account after repeated failures', async () => {
    await registered('lock@example.com');
    const c = await client();
    for (let i = 0; i < 5; i++) await send(c, 'post', '/api/auth/login', { email: 'lock@example.com', password: 'bad-password-x' });
    const r = await send(c, 'post', '/api/auth/login', { email: 'lock@example.com', password: 'correct-horse-battery' });
    expect(r.status).toBe(429);
  });

  it('rejects forged / tampered session cookies', async () => {
    const r = await request(app).get('/api/twins').set('Cookie', 'mc_session=' + 'A'.repeat(43));
    expect(r.status).toBe(401);
  });

  it('revokes other sessions on password change', async () => {
    const a = await registered('pw@example.com');
    const b = await client();
    const login = await send(b, 'post', '/api/auth/login', { email: 'pw@example.com', password: 'correct-horse-battery' });
    expect(login.status).toBe(200);
    const csrfB = ([] as string[]).concat(login.headers['set-cookie']).find((x) => x.startsWith('mc_csrf='))!;
    b.csrf = csrfB.split(';')[0].split('=')[1];
    const r = await send(a, 'post', '/api/auth/password', { currentPassword: 'correct-horse-battery', newPassword: 'another-strong-pass' });
    expect(r.status).toBe(200);
    expect((await b.agent.get('/api/twins')).status).toBe(401);
    expect((await a.agent.get('/api/twins')).status).toBe(200);
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without token', async () => {
    const c = await registered('csrf@example.com');
    const r = await c.agent.post('/api/twins').set('content-type', 'application/json').send(JSON.stringify(twin()));
    expect(r.status).toBe(403);
  });
  it('rejects mismatched token', async () => {
    const c = await registered('csrf2@example.com');
    const r = await c.agent.post('/api/twins').set('x-csrf-token', 'x'.repeat(32)).set('content-type', 'application/json').send(JSON.stringify(twin()));
    expect(r.status).toBe(403);
  });
  it('rejects foreign Origin even with valid token', async () => {
    const c = await registered('csrf3@example.com');
    const r = await c.agent.post('/api/twins').set('x-csrf-token', c.csrf).set('origin', 'https://evil.example').set('content-type', 'application/json').send(JSON.stringify(twin()));
    expect(r.status).toBe(403);
  });
  it('rejects non-JSON bodies (form-post CSRF vector)', async () => {
    const c = await registered('csrf4@example.com');
    const r = await c.agent.post('/api/twins').set('x-csrf-token', c.csrf).type('form').send('name=x');
    expect(r.status).toBe(415);
  });
});

describe('authorization & IDOR', () => {
  it('requires authentication for private resources', async () => {
    for (const url of ['/api/twins', '/api/simulations', '/api/compounds', '/api/training/attempts', '/api/stats']) {
      expect((await request(app).get(url)).status).toBe(401);
    }
  });

  it('prevents users accessing each other’s twins', async () => {
    const a = await registered('owner@example.com');
    const b = await registered('attacker@example.com');
    const created = await send(a, 'post', '/api/twins', twin('Private'));
    expect(created.status).toBe(201);
    const id = created.body.twin.id;
    expect((await b.agent.get(`/api/twins/${id}`)).status).toBe(404);
    expect((await send(b, 'put', `/api/twins/${id}`, twin('Hacked'))).status).toBe(404);
    expect((await send(b, 'delete', `/api/twins/${id}`)).status).toBe(404);
    expect((await b.agent.get('/api/twins')).body.twins).toHaveLength(0);
    expect((await a.agent.get(`/api/twins/${id}`)).body.twin.name).toBe('Private');
  });

  it('blocks non-admins from admin endpoints', async () => {
    const c = await registered('nonadmin@example.com');
    expect((await c.agent.get('/api/admin/users')).status).toBe(403);
    expect((await c.agent.get('/api/admin/audit')).status).toBe(403);
  });

  it('admin can manage users and read audit log', async () => {
    const hash = await hashPassword('admin-strong-password');
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('admin1', 'root@example.com', 'Root', ?, 'admin', ?)").run(hash, Date.now());
    const c = await client();
    const r = await send(c, 'post', '/api/auth/login', { email: 'root@example.com', password: 'admin-strong-password' });
    c.csrf = ([] as string[]).concat(r.headers['set-cookie']).find((x) => x.startsWith('mc_csrf='))!.split(';')[0].split('=')[1];
    const users = await c.agent.get('/api/admin/users');
    expect(users.status).toBe(200);
    expect(JSON.stringify(users.body)).not.toContain('password_hash');
    const target = users.body.users.find((u: { email: string }) => u.email === 'nonadmin@example.com');
    expect((await send(c, 'patch', `/api/admin/users/${target.id}`, { disabled: true })).status).toBe(200);
    expect((await send(c, 'patch', '/api/admin/users/admin1', { role: 'student' })).status).toBe(400);
    const audit = await c.agent.get('/api/admin/audit');
    expect(audit.body.events.some((e: { action: string }) => e.action === 'admin.user.update')).toBe(true);
  });

  it('demo account cannot change credentials', async () => {
    const c = await client();
    const r = await send(c, 'post', '/api/auth/login', { email: 'demo@medcare.dev', password: 'MedCare-Demo-2026' });
    expect(r.status).toBe(200);
    c.csrf = ([] as string[]).concat(r.headers['set-cookie']).find((x) => x.startsWith('mc_csrf='))!.split(';')[0].split('=')[1];
    expect((await c.agent.get('/api/twins')).body.twins.length).toBeGreaterThanOrEqual(4);
    expect((await send(c, 'post', '/api/auth/password', { currentPassword: 'MedCare-Demo-2026', newPassword: 'hijacked-password' })).status).toBe(403);
    expect((await send(c, 'post', '/api/auth/totp/setup')).status).toBe(403);
  });
});

describe('input validation & injection', () => {
  it('rejects SQL-injection shaped identifiers', async () => {
    const c = await registered('sqli@example.com');
    const r = await c.agent.get(`/api/twins/${encodeURIComponent("1' OR '1'='1")}`);
    expect(r.status).toBe(400);
    const login = await send(c, 'post', '/api/auth/login', { email: "' OR 1=1 --", password: 'x' });
    expect(login.status).toBe(400);
  });

  it('rejects out-of-range physiology and unknown drugs', async () => {
    const c = await registered('val@example.com');
    const bad = twin();
    (bad.data as { age: number }).age = -5;
    expect((await send(c, 'post', '/api/twins', bad)).status).toBe(400);
    const r = await send(c, 'post', '/api/simulate', {
      patient: defaultPatient(),
      regimens: [{ id: 'r1', drugId: 'cyanide', dose: 10, unit: 'mg', intervalH: 24, route: 'po', startH: 0, doses: 1 }],
    });
    expect(r.status).toBe(400);
  });

  it('stores script payloads inert as data (rendered escaped by the client)', async () => {
    const c = await registered('xss@example.com');
    const r = await send(c, 'post', '/api/twins', twin('<img src=x onerror=alert(1)>'));
    expect(r.status).toBe(201);
    const g = await c.agent.get(`/api/twins/${r.body.twin.id}`);
    expect(g.headers['content-type']).toMatch(/application\/json/);
  });

  it('rejects malformed and oversized JSON', async () => {
    const c = await registered('big@example.com');
    const bad = await c.agent.post('/api/twins').set('x-csrf-token', c.csrf).set('content-type', 'application/json').send('{"name":');
    expect(bad.status).toBe(400);
    const big = await send(c, 'post', '/api/twins', { name: 'x', data: 'y'.repeat(600_000) });
    expect(big.status).toBe(413);
  });

  it('ignores prototype-pollution keys', async () => {
    const c = await registered('proto@example.com');
    const body = JSON.stringify({ ...twin(), __proto__: { role: 'admin' } }).replace('"name"', '"__proto__":{"isAdmin":true},"name"');
    const r = await c.agent.post('/api/twins').set('x-csrf-token', c.csrf).set('content-type', 'application/json').send(body);
    expect(r.status).toBe(201);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });
});

describe('features', () => {
  it('simulates on the server with alerts and recommendations', async () => {
    const c = await registered('sim@example.com');
    const r = await send(c, 'post', '/api/simulate', {
      patient: defaultPatient({ scr: 2.5 }),
      regimens: [
        { id: 'r1', drugId: 'vancomycin', dose: 1500, unit: 'mg', intervalH: 12, route: 'iv_infusion', infusionH: 1.5, startH: 0, doses: 8 },
        { id: 'r2', drugId: 'gentamicin', dose: 5, unit: 'mg/kg', intervalH: 24, route: 'iv_infusion', infusionH: 0.5, startH: 0, doses: 4 },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.metrics.vancomycin.auc24).toBeGreaterThan(600);
    expect(r.body.alerts.some((a: { title: string }) => a.title === 'Combined nephrotoxicity')).toBe(true);
    expect(r.body.recommendations[0].recommendedDose).toBeLessThan(1500);
  });

  it('scores training attempts server-side (client score ignored)', async () => {
    const c = await registered('train@example.com');
    const cs = TRAINING_CASES[0];
    const r = await send(c, 'post', '/api/training/attempts', { caseId: cs.id, answers: { q1: 0 }, score: 999 });
    expect(r.status).toBe(201);
    expect(r.body.attempt.score).toBe(0);
    expect(r.body.attempt.total).toBe(cs.questions.length);
  });

  it('saves and lists experiments and compounds', async () => {
    const c = await registered('exp@example.com');
    const s = await send(c, 'post', '/api/simulations', { name: 'Run 1', kind: 'simulation', config: { a: 1 }, summary: { b: 2 } });
    expect(s.status).toBe(201);
    expect((await c.agent.get('/api/simulations')).body.simulations).toHaveLength(1);
    const comp = await send(c, 'post', '/api/compounds', {
      name: 'X', mw: 400, logP: 2, hbd: 1, hba: 5, tpsa: 80, rotatableBonds: 4, solubility: 1, permeability: 20, fu: 0.1,
      species: 'rat', noaelMgKg: 10, animalCL_mLminKg: 20, animalVss_Lkg: 1, targetConc: 0.1, safetyFactor: 10, F: 0.5, ka: 1,
    });
    expect(comp.status).toBe(201);
  });

  it('supports TOTP two-factor login with replay protection', async () => {
    const c = await registered('mfa@example.com');
    const setup = await send(c, 'post', '/api/auth/totp/setup');
    const secret = setup.body.secret as string;
    const code = hotp(secret, Math.floor(Date.now() / 30000));
    expect((await send(c, 'post', '/api/auth/totp/enable', { code })).status).toBe(200);
    const fresh = await client();
    const noCode = await send(fresh, 'post', '/api/auth/login', { email: 'mfa@example.com', password: 'correct-horse-battery' });
    expect(noCode.status).toBe(401);
    // the code used for enrolment cannot be replayed
    const replay = await send(fresh, 'post', '/api/auth/login', { email: 'mfa@example.com', password: 'correct-horse-battery', totp: code });
    expect(replay.status).toBe(401);
    const next = hotp(secret, Math.floor(Date.now() / 30000) + 1);
    const ok = await send(fresh, 'post', '/api/auth/login', { email: 'mfa@example.com', password: 'correct-horse-battery', totp: next });
    expect(ok.status).toBe(200);
    const row = db.prepare("SELECT totp_secret FROM users WHERE email = 'mfa@example.com'").get() as { totp_secret: string };
    expect(row.totp_secret).not.toContain(secret);
  });
});
