/**
 * routes/images —— `fetch_image` 缓存图片的出图通道（`GET /api/images/:name`）。
 *
 * 与 `routes/preview.ts` 的分工：那边出**内存里的模型 HTML**（一次性的、可重生成）；
 * 这边出**落盘的第三方图片副本**（正文里引用了它，必须长期可渲染）。
 *
 * 安全边界（全在 `storage/image-cache.ts` 那一侧，本文件只做出口）：
 * ① `:name` 必须匹配 `<32 hex>.<png|jpg|gif|webp|bmp|avif>` —— `..` / 路径分隔符 / 绝对路径 /
 *    其他扩展名（尤其 `.svg`，同源直接打开会执行脚本）全部不匹配 ⇒ **路径穿越的唯一闸门**；
 * ② 只出 `DATA_DIR/images/` 下的文件，该目录由服务端写、模型只能给 URL 给不了路径；
 * ③ `security.ts` 全局挂 `X-Content-Type-Options: nosniff` ⇒ Content-Type 必须**准**
 *    （按扩展名映射，不猜、不 `octet-stream` 兜底），否则浏览器会拒绝渲染。
 *
 * 不做归属校验：名字是**内容 hash**，不可枚举、不含任何用户信息；同 `routes/preview.ts`
 * 的 id 口径（不可猜即可访问）。图片是「用户正在看的第三方内容」的本地副本，不含本应用数据。
 */
import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { imagePath, mimeOfName } from '../storage/image-cache.js';

export const imagesRouter = Router();

imagesRouter.get('/:name', (req: Request, res: Response) => {
  const full = imagePath(String(req.params.name ?? ''));
  if (!full || !fs.existsSync(full)) {
    // 与 preview 同口径：失效要如实说、并指一条出路，不静默给空图
    res.status(404).json({ error: '图片不存在（可能已被清理），可回到对话让它重新取一次' });
    return;
  }
  res.setHeader('Content-Type', mimeOfName(path.basename(full)));
  // 名字 = 内容 hash ⇒ 内容永不改变，可以长缓存。这不只是省流量：历史消息回放时
  // 同一张图会被反复引用，没有它每滚一次就重新拉一遍磁盘。
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  createReadStream(full).pipe(res);
});
