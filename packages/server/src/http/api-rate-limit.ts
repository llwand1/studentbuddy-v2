import type { Request, RequestHandler } from 'express';
import { REQUIRE_AUTH } from '../auth/form.js';
import { ownerIdOf } from '../auth/ownership.js';
import { RateWindow } from './rate-window.js';

export const API_RATE_POLICY = { general: 600, costly: 60, windowMs: 60_000, maxKeys: 10_000 } as const;
const routePath = (req: Request): string => req.originalUrl.split('?')[0]!.replace(/\/+$/, '').toLowerCase();
export function costlyRequest(req: Request): boolean {
  const route = routePath(req);
  return /^\/api\/(chat\/(send|regenerate|resend|opener)|quiz\/(generate|explain|feedback\/(choices|adapt))|learning\/grade|drill\/new-terms|guide\/next|scenario\/generate|continent\/expand\/offer|terms\/extract|doc\/url|settings\/search\/test)$/.test(route)
    || /^\/api\/(sources\/(view|read|probe|shot|videos)|lookup\/(wiki|explain|quiz)|npc(?:\/ping|\/[^/]+\/talk)?)$/.test(route)
    || /^\/api\/(providers\/[^/]+\/models|plugins\/([^/]+\/test|github\/repositories))$/.test(route);
}
interface Options {
  limit: number; windowMs?: number; maxKeys?: number;
  enabled?: () => boolean; key?: (req: Request) => string; applies?: (req: Request) => boolean; now?: () => number;
}
export function createApiLimiter(options: Options): RequestHandler {
  const budget = new RateWindow(options.limit, options.windowMs, options.maxKeys);
  return (req, res, next) => {
    if (!(options.enabled ?? (() => REQUIRE_AUTH))() || req.method === 'OPTIONS'
      || /^\/api\/(health|status)$/.test(routePath(req)) || options.applies && !options.applies(req)) { next(); return; }
    const state = budget.consume(options.key?.(req) ?? `ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`, (options.now ?? Date.now)());
    res.setHeader('RateLimit-Limit', options.limit); res.setHeader('RateLimit-Remaining', state.remaining);
    res.setHeader('RateLimit-Reset', state.retryAfterSeconds);
    if (state.allowed) { next(); return; }
    res.setHeader('Retry-After', state.retryAfterSeconds); res.setHeader('Cache-Control', 'no-store');
    res.status(429).json({ error: '请求过于频繁，请稍后重试', code: 'RATE_LIMITED', retryAfterSeconds: state.retryAfterSeconds });
  };
}
export const apiIpBudget = createApiLimiter({ limit: API_RATE_POLICY.general });
export function requestBudgetIdentity(req: Request): string {
  const owner = ownerIdOf(req); return owner ? `user:${owner}` : `ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
}
export const apiCostlyBudget = createApiLimiter({ limit: API_RATE_POLICY.costly, applies: costlyRequest,
  key: requestBudgetIdentity });
