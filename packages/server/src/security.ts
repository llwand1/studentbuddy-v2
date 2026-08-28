/**
 * 安全中间件：CORS 白名单 / Origin 校验 / 安全响应头 / 请求体限制。
 * 精简自 v1 打磨件（安全三件必要件之 Origin 校验），AI 零写盘 ⇒ 不再有审批门/策略引擎。
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';

const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:18791',
  'http://localhost:18791',
]);

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return false; // 写操作必须携带 Origin（SEC-09 语义）
  // 不放行 'null'：CSP sandbox 的 html 预览页 Origin 就是字符串 null，放行等于让模型写的
  // 网页能调写接口 + 读到带 CORS 头的 JSON（v1 file:// 遗留规则在 v2 无场景，已删）
  return ALLOWED_ORIGINS.has(origin) || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

export function isReadonlyMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
};

/** 写操作强制 Origin 校验（防恶意网页跨源调用本地服务，继承 v1 修复） */
export function originCheck(req: Request, res: Response, next: NextFunction): void {
  if (isReadonlyMethod(req.method) || isAllowedOrigin(req.headers.origin)) {
    next();
    return;
  }
  res.status(403).json({ error: 'Forbidden: missing or disallowed origin' });
}
