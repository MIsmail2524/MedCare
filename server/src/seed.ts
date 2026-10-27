import { randomUUID } from 'node:crypto';
import { defaultPatient, type Patient } from '@medcare/engine';
import type { DB } from './db.js';
import { hashPassword } from './security/password.js';

export const DEMO_EMAIL = 'demo@medcare.dev';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'MedCare-Demo-2026';

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString();

export function demoTwins(): { name: string; data: Patient }[] {
  return [
    {
      name: 'Amina K. — AF with CKD 3b',
      data: defaultPatient({
        name: 'Amina K.', age: 74, sex: 'female', weightKg: 64, heightCm: 158, scr: 1.6, albumin: 3.6, potassium: 3.9,
        phenotypes: { CYP2D6: 'NM', CYP2C19: 'IM', CYP2C9: 'IM', CYP3A5: 'PM' }, vkorc1: 'AG',
        conditions: [
          { id: 'c1', name: 'Atrial fibrillation', since: '2021-04-01' },
          { id: 'c2', name: 'Chronic kidney disease G3b', since: '2019-09-01' },
          { id: 'c3', name: 'Hypertension', since: '2012-01-01' },
        ],
        allergies: ['penicillin'],
        procedures: [{ id: 'p1', type: 'pci', date: '2024-02-14' }],
        medicationHistory: [
          { id: 'm1', drugId: 'amiodarone', dose: 200, unit: 'mg', intervalH: 24, route: 'po', start: day(-150), end: day(-20), notes: 'Rhythm control; stopped for thyroid dysfunction' },
          { id: 'm2', drugId: 'warfarin', dose: 3, unit: 'mg', intervalH: 24, route: 'po', start: day(-400), end: day(0) },
        ],
      }),
    },
    {
      name: 'Daniel R. — Epilepsy after gastric bypass',
      data: defaultPatient({
        name: 'Daniel R.', age: 38, sex: 'male', weightKg: 92, heightCm: 180, scr: 0.9,
        phenotypes: { CYP2D6: 'UM', CYP2C19: 'PM', CYP2C9: 'NM', CYP3A5: 'PM' },
        conditions: [{ id: 'c1', name: 'Focal epilepsy', since: '2015-06-01' }, { id: 'c2', name: 'Obesity (pre-surgery BMI 44)' }],
        procedures: [{ id: 'p1', type: 'rygb', date: '2023-05-20' }],
        medicationHistory: [{ id: 'm1', drugId: 'rifampin', dose: 600, unit: 'mg', intervalH: 24, route: 'po', start: day(-30), end: day(-4), notes: 'Staphylococcal infection' }],
      }),
    },
    {
      name: 'Mei L. — Kidney transplant recipient',
      data: defaultPatient({
        name: 'Mei L.', age: 46, sex: 'female', weightKg: 55, heightCm: 160, scr: 1.3,
        phenotypes: { CYP2D6: 'IM', CYP2C19: 'PM', CYP2C9: 'NM', CYP3A5: 'NM' }, vkorc1: 'AA',
        conditions: [{ id: 'c1', name: 'IgA nephropathy → ESKD', since: '2018-01-01' }],
        procedures: [{ id: 'p1', type: 'kidney_tx', date: day(-200).slice(0, 10) }],
        medicationHistory: [{ id: 'm1', drugId: 'tacrolimus', dose: 3, unit: 'mg', intervalH: 12, route: 'po', start: day(-200), end: day(0) }],
      }),
    },
    {
      name: 'Sara M. — Breast cancer survivor',
      data: defaultPatient({
        name: 'Sara M.', age: 52, sex: 'female', weightKg: 70, heightCm: 167, scr: 0.8,
        conditions: [{ id: 'c1', name: 'HER2-negative breast cancer (remission)', since: '2025-01-10' }],
        medicationHistory: [
          { id: 'm1', drugId: 'doxorubicin', dose: 60, unit: 'mg/m2', intervalH: 504, route: 'iv_infusion', infusionH: 0.25, start: day(-420), end: day(-300), notes: 'AC regimen × 6' },
          { id: 'm2', drugId: 'ondansetron', dose: 8, unit: 'mg', intervalH: 12, route: 'po', start: day(-420), end: day(-300) },
        ],
      }),
    },
  ];
}

async function createUser(db: DB, email: string, name: string, password: string, role: string, isDemo: boolean) {
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, email, name, password_hash, role, organisation, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, email, name, await hashPassword(password), role, 'MedCare Demo', isDemo ? 1 : 0, Date.now(),
  );
  return id;
}

/** Idempotent seed: a shared demo clinician account with sample twins, plus an admin when configured. */
export async function ensureSeed(db: DB) {
  if (process.env.SEED_DEMO !== 'false' && !db.prepare('SELECT 1 FROM users WHERE email = ?').get(DEMO_EMAIL)) {
    const id = await createUser(db, DEMO_EMAIL, 'Demo Clinician', DEMO_PASSWORD, 'clinician', true);
    const now = Date.now();
    for (const t of demoTwins()) {
      db.prepare('INSERT INTO twins (id, user_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), id, t.name, JSON.stringify(t.data), now, now);
    }
  }
  const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword && !db.prepare('SELECT 1 FROM users WHERE email = ?').get(adminEmail)) {
    await createUser(db, adminEmail, 'Administrator', adminPassword, 'admin', false);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { openDb } = await import('./db.js');
  const { config } = await import('./config.js');
  await ensureSeed(openDb(config.databasePath));
  console.log('Seed complete');
}
