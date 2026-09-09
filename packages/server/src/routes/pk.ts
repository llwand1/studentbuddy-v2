/**
 * routes/pk — AI 出题 PK 薄路由（契约 docs/PK-SPEC.md，先契约后实现）。
 * P0-1 只落登录两端点；房间/对战端点随 P0-2 追加到同一 router。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getIdentity, loginOrRegister } from '../pk/auth.js';

export const pkRouter = Router();

/**
 * 登录（P0 模拟实现，契约 §2.1）：{ nickname, userId? } → PkIdentity。
 * 携带已存在的 userId = 找回账号（可顺带改名）；否则新建。
 * P1 替换为微信公众号网页授权（oauth2 code → openid）时：入参换成 code、
 * openid 换真值，**响应结构不变**——前端零改动（契约先行的意义所在）。
 */
pkRouter.post('/auth/login', (req: Request, res: Response) => {
  const { nickname, userId } = req.body as { nickname?: unknown; userId?: unknown };
  if (userId !== undefined && (typeof userId !== 'string' || !userId)) {
    res.status(400).json({ error: 'userId 必须是非空字符串' });
    return;
  }
  try {
    res.json(loginOrRegister(nickname as string, userId));
  } catch {
    // 域层只抛 NICKNAME_INVALID 一种错（唯一已知失败因），薄路由按语义转 400
    res.status(400).json({ error: 'nickname 必填（1~20 字）' });
  }
});

/** 本地登录态校验：userId 命中 → PkIdentity；不存在 → 404（前端据此清 localStorage）。 */
pkRouter.get('/auth/me', (req: Request, res: Response) => {
  const identity = getIdentity(req.query.userId);
  if (!identity) {
    res.status(404).json({ error: '账号不存在' });
    return;
  }
  res.json(identity);
});
