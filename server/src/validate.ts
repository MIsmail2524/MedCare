import type { z } from 'zod';
import { HttpError } from './auth.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const details = r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new HttpError(400, 'Validation failed', details);
  }
  return r.data;
}

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function paramId(v: unknown): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new HttpError(400, 'Invalid id');
  return v;
}
