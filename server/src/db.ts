import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE COLLATE NOCASE,
     name TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('student','clinician','researcher','admin')),
     organisation TEXT,
     totp_secret TEXT,
     totp_enabled INTEGER NOT NULL DEFAULT 0,
     totp_last_counter INTEGER NOT NULL DEFAULT 0,
     failed_attempts INTEGER NOT NULL DEFAULT 0,
     locked_until INTEGER NOT NULL DEFAULT 0,
     disabled INTEGER NOT NULL DEFAULT 0,
     is_demo INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     last_login_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     ip TEXT,
     user_agent TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS twins (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_twins_user ON twins(user_id)`,
  `CREATE TABLE IF NOT EXISTS simulations (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     twin_id TEXT,
     name TEXT NOT NULL,
     kind TEXT NOT NULL,
     config TEXT NOT NULL,
     summary TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sims_user ON simulations(user_id)`,
  `CREATE TABLE IF NOT EXISTS compounds (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS training_attempts (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     case_id TEXT NOT NULL,
     score INTEGER NOT NULL,
     total INTEGER NOT NULL,
     answers TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_user ON training_attempts(user_id)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT,
     action TEXT NOT NULL,
     target TEXT,
     ip TEXT,
     meta TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at)`,
];

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  for (const m of MIGRATIONS) db.exec(m);
  return db;
}
