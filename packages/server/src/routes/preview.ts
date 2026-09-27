/**
 * routes/preview — ```html 围栏的预览出页通道（侧栏内置浏览器面板与新标签页共用）。
 * 只做内存暂存（上限 20 条，超量丢最旧）+ 出页，不落盘（AI 零写盘）。
 *
 * 出页必带 `Content-Security-Policy: sandbox allow-scripts`（刻意不给 allow-same-origin）：
 * 文档因此变成 opaque origin —— 脚本照跑（demo 交互可用），但它读不到本应用的
 * localStorage、也带不出被放行的 Origin（security.ts 已不再放行 'null'）⇒ 写接口 403、
 * JSON 拿不到 CORS 头。这是「模型写的 HTML 能安全打开」的根条件。
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';

/** 单份预览 HTML 上限（演示页量级；远低于全局 2MB json 限制） */
const MAX_HTML = 512 * 1024;
/** 暂存条数上限：再多丢最旧（预览是可派生数据，不需要持久） */
const MAX_ITEMS = 20;

/** id → html；Map 插入序即时间序 */
const store = new Map<string, string>();

/** 模型常给片段：无 <html> 时补最小文档壳（charset + viewport），已是完整文档则原样出。 */
function wrapFragment(html: string): string {
  if (/<html[\s>]/i.test(html)) return html;
  return [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `</head><body>${html}</body></html>`,
  ].join('');
}

export const previewRouter = Router();

/** 登记一份预览 HTML → 换 id（点击「打开」时才调用，渲染不写内存） */
previewRouter.post('/', (req: Request, res: Response) => {
  const { html } = req.body as { html?: unknown };
  if (typeof html !== 'string' || !html.trim()) {
    res.status(400).json({ error: 'html 必须是非空字符串' });
    return;
  }
  if (html.length > MAX_HTML) {
    res.status(400).json({ error: `html 超出 ${MAX_HTML} 字符上限` });
    return;
  }
  const id = randomUUID();
  store.set(id, html);
  if (store.size > MAX_ITEMS) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  res.json({ id });
});

/** 出页：sandbox 隔离 + 明确降级提示（服务重启或挤掉后 id 失效） */
previewRouter.get('/:id', (req: Request, res: Response) => {
  const html = store.get(req.params.id ?? '');
  res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-modals allow-forms');
  // 全局安全头是 X-Frame-Options: DENY，会把本应用的侧栏预览面板一起挡掉。预览页只对同源开放
  // 嵌入（外站嵌不到），且它已被上面那条 CSP 变成 opaque origin —— 即便被嵌也读不到本应用数据。
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (!html) {
    res
      .status(404)
      .type('html')
      .send('<meta charset="utf-8">预览已失效（服务重启或超出暂存上限），请回到对话重新点「侧栏预览」。');
    return;
  }
  res.type('html').send(wrapFragment(html));
});
