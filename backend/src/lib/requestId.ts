// Correlation-ID middleware. Attaches a stable request id to every request so
// logs, error responses and the operations center can be tied together.
//
// Honors an inbound `X-Request-Id` (from the reverse proxy or a client) when it
// looks safe, else mints a fresh UUID. The id is echoed back on the response
// header and stored on `req.id` for downstream handlers / the error handler.
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// Bound length + charset so a hostile inbound header can't poison logs.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers['x-request-id'];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const id = candidate && SAFE_ID.test(candidate) ? candidate : crypto.randomUUID();
  (req as Request & { id?: string }).id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/** Read the correlation id attached by the middleware (undefined if absent). */
export function getRequestId(req: Request): string | undefined {
  return (req as Request & { id?: string }).id;
}
