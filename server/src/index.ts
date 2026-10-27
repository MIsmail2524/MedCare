import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { ensureSeed } from './seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(config.databasePath);
await ensureSeed(db);
const staticDir = config.staticDir ?? path.resolve(here, '../../web/dist');
const app = createApp(db, { staticDir });

// Periodic cleanup of expired sessions.
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?').run(Date.now(), Date.now() - config.sessionIdleMinutes * 60_000);
}, 10 * 60_000).unref();

const server = app.listen(config.port, config.host, () => {
  console.log(`MedCare Twin listening on http://${config.host}:${config.port}`);
});
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
