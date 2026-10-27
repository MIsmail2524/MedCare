import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { csrfProtection, HttpError, sessionMiddleware } from './auth.js';
import { config, isProd, isTest } from './config.js';
import type { DB } from './db.js';
import { authRouter } from './routes/auth.js';
import { dataRouter } from './routes/data.js';

export function createApp(db: DB, opts: { staticDir?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          workerSrc: ["'self'", 'blob:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.cookieSecure ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: config.cookieSecure ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    next();
  });

  if (!isTest) {
    app.use((req, res, next) => {
      const start = process.hrtime.bigint();
      res.on('finish', () => {
        if (!req.path.startsWith('/api')) return;
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        console.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: req.path, s: res.statusCode, ms: Math.round(ms) }));
      });
      next();
    });
  }

  const api = express.Router();
  api.use(rateLimit({ windowMs: 15 * 60_000, limit: isTest ? 100000 : 1500, standardHeaders: 'draft-7', legacyHeaders: false }));
  api.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return next(new HttpError(415, 'Content-Type must be application/json'));
    }
    next();
  });
  api.use(express.json({ limit: '512kb', strict: true }));
  api.use(cookieParser());
  api.use(sessionMiddleware(db));
  api.use(csrfProtection);
  api.get('/health', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', time: new Date().toISOString() });
  });
  api.use('/auth', authRouter(db));
  api.use('/', dataRouter(db));
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use('/api', api);

  const staticDir = opts.staticDir ?? config.staticDir;
  if (staticDir && existsSync(staticDir)) {
    app.use(
      express.static(staticDir, {
        index: false,
        setHeaders(res, file) {
          res.setHeader('Cache-Control', /\/assets\//.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Malformed JSON' });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body too large' });
      return;
    }
    console.error(isProd ? String(err) : err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
