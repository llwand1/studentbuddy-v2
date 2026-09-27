/**
 * ```html 预览的上传件：源码换服务端暂存 id → 预览路径。
 * 只在用户点按钮时调用（渲染期零请求、零写盘），侧栏面板与新标签页共用这一条路。
 */
export async function uploadPreview(html: string): Promise<string> {
  const res = await fetch('/api/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ html }),
  });
  // 404/5xx 出的是 HTML 而非 JSON，解析失败时保留状态码做提示
  const body = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
  if (!res.ok || !body?.id) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return `/api/preview/${body.id}`;
}

/** 面板标题优先用 demo 自己的 `<title>`（模型一般会写），没有就回落到卡片名 */
export function pickTitle(html: string, fallback: string): string {
  const raw = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(html)?.[1]?.trim();
  return raw && raw.length > 0 ? raw : fallback;
}
