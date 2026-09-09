// chat-meta.ts —— 对话页的纯展示规则（无 DOM、可单测）：工具中文名 / 轮次元信息 / 贴底判定。
// 抽出来的三个理由：① ChatView 已 254 行、web 红线 300，表现层规则外移才守得住；
// ② 这三条规则都有边界（未登记工具、usage 缺失、临界距离），写进 JSX 就没法单测；
// ③ 工具中文名是「新工具注册后必须补一行」的清单点，单列一处比埋在组件里好找。

/** 工具中文名。新工具在 `server/chat/tools.ts` 注册后在此补一行。 */
const TOOL_LABELS: Record<string, string> = {
  search_web: '联网搜索',
  tidy_terms: '整理词条',
  manage_terms: '管理词条',
};

/**
 * 未登记的工具回退原 key（不返回空串、不返回"未知工具"）：
 * 宁可让用户看见 `xxx_tool` 这种英文，也不把「这里有个工具在跑」这件事藏掉（ADR-5 不静默）。
 */
export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

/** 小于 1000 原样，否则取一位小数 k（1200 → 1.2k；1000 → 1k，不显示 1.0k） */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : Number(k.toFixed(1))}k`;
}

/** 耗时人话：820ms / 8.3s / 2 分 5 秒 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(1))}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`;
}

/**
 * 轮次元信息：`1.2k tokens · 8.3s`。
 * usage 缺失（服务端估算路径之外的老流）时只显示耗时——**不编造 token 数**；两者都无则返回空串（调用方据此不渲染）。
 */
export function formatRoundMeta(
  usage: { promptTokens: number; completionTokens: number } | null | undefined,
  ms?: number,
): string {
  const dur = typeof ms === 'number' && ms > 0 ? formatDuration(ms) : '';
  const total = usage ? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0) : 0;
  if (total <= 0) return dur;
  const tok = `${formatTokens(total)} tokens`;
  return dur ? `${tok} · ${dur}` : tok;
}

/**
 * SQLite 的 `datetime('now')` 产出的是 **UTC 且不带时区标记**（`'2026-09-09 07:52:03'`），
 * 直接 `new Date(...)` 会按浏览器本地时区解析 → 在东八区差 8 小时。故统一补 Z 按 UTC 解析；
 * 已经是 ISO（带 T / Z / ±hh:mm）的原样交给 Date。
 */
function parseMsgDate(ts: string | number): Date | null {
  if (typeof ts === 'number') {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = ts.trim();
  if (!s) return null;
  const hasZone = /[TZ]/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
  const d = new Date(hasZone ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 消息时间：今天只显示 `HH:mm`，跨天补 `M月D日`。解析不出时间返回空串（调用方据此不渲染） */
export function formatMsgTime(ts: string | number | undefined, now: Date = new Date()): string {
  const d = ts === undefined || ts === null ? null : parseMsgDate(ts);
  if (!d) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/**
 * 是否跟随滚动：距底 ≤ 阈值才算「用户在看最新」。
 * 阈值给 80px 而不是 0：smooth 滚动与块级渲染（表格/图片进场会顶高）都会让距离在几十像素内抖动，
 * 用严格 0 会出现「明明贴着底却不跟随」的假阴性。
 */
export function shouldAutoScroll(distanceFromBottom: number, threshold = 80): boolean {
  if (!Number.isFinite(distanceFromBottom)) return true;
  return distanceFromBottom <= threshold;
}
