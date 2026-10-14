import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';

const logger = pino({ name: 'sb-http' });
interface Failure { requestId: string; method: string; status: number; code: string }
function classify(error: unknown): { status: number; code: string; message: string } {
  let type: unknown;
  try { type = error && typeof error === 'object' && 'type' in error ? error.type : null; }
  catch { type = null; }
  if (type === 'entity.parse.failed') return { status: 400, code: 'INVALID_JSON', message: '请求正文不是有效 JSON' };
  if (type === 'entity.too.large') return { status: 413, code: 'BODY_TOO_LARGE', message: '请求正文过大，请减少附件或内容' };
  return { status: 500, code: 'INTERNAL_ERROR', message: '服务暂时无法完成请求，请稍后重试' };
}

/** Final four-argument middleware. Logs deliberately exclude error messages, URLs and bodies. */
export function createErrorBoundary(report: (failure: Failure) => void = failure => logger.error(failure, 'HTTP request failed')): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    const { status, code, message } = classify(error), requestId = randomUUID();
    try { report({ requestId, method: /^[A-Z]{3,10}$/.test(req.method) ? req.method : 'UNKNOWN', status, code }); }
    catch { /* Telemetry failures must not replace the safe HTTP response. */ }
    if (res.destroyed || req.aborted) return;
    // A fixed, non-sentinel value lets Express close the failed stream without logging private errors.
    if (res.headersSent) { next('HTTP_STREAM_FAILURE'); return; }
    res.setHeader('X-Request-Id', requestId); res.setHeader('Cache-Control', 'no-store');
    res.status(status).json({ error: message, code, requestId });
  };
}
