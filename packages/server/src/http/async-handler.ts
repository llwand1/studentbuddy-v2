import type { NextFunction, Request, RequestHandler, Response } from 'express';

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

/** Express 4 does not consume returned Promises. Never forward route/router sentinel rejections. */
export function asyncHandler(handler: Handler): RequestHandler {
  const failure = (value: unknown): Error => {
    try { if (value instanceof Error) return value; } catch { /* Revoked proxies are non-Error rejections too. */ }
    return new Error('HTTP_HANDLER_REJECTED');
  };
  return (req, res, next) => {
    try { void Promise.resolve(handler(req, res, next)).catch((error: unknown) => next(failure(error))); }
    catch (error) { next(failure(error)); }
  };
}
