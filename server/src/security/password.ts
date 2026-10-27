import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const N = 2 ** 15;
const r = 8;
const p = 1;
const KEYLEN = 64;
const MAXMEM = 128 * N * r * 2;

function scrypt(password: string, salt: Buffer, n = N, rr = r, pp = p): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, KEYLEN, { N: n, r: rr, p: pp, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, rr, pp, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), Number(n), Number(rr), Number(pp));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Pre-computed hash so login timing does not reveal whether an account exists. */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}

const COMMON = new Set([
  'password', 'password1', 'password123', '123456789', '1234567890', 'qwertyuiop', 'iloveyou', 'admin12345', 'letmein123',
  'welcome123', 'medcare123', 'passw0rd!', 'changeme123', 'qwerty12345', '1q2w3e4r5t', 'abc123456', 'doctor123', 'hospital123',
]);

/** NIST SP 800-63B style policy: length plus blocklist, no arbitrary composition rules. */
export function passwordProblems(password: string, email?: string): string[] {
  const issues: string[] = [];
  if (password.length < 10) issues.push('Use at least 10 characters.');
  if (password.length > 128) issues.push('Use at most 128 characters.');
  if (COMMON.has(password.toLowerCase())) issues.push('This password is too common.');
  if (/^(.)\1+$/.test(password)) issues.push('Avoid repeated characters.');
  if (email && password.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4) issues.push('Do not include your email name.');
  return issues;
}
