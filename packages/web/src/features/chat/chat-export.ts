// chat-export.ts —— 对话导出为 Markdown（纯函数 + 触发下载，零依赖）。
// 为什么值得单测：导出物是用户资产（笔记的原料），格式写歪一次就污染他粘贴出去的东西；
// 下载触发（DOM/Blob）不可单测，所以「内容生成」与「触发」必须拆开——前者纯函数可测，后者薄薄一层。
import { parseMsgDate } from './chat-meta';

export interface ExportMsg {
  role: 'user' | 'assistant';
  content: string;
  ts?: string;
}

/** 完整日期时间（本地）：`2026-09-09 15:52`。导出场景要能定位到哪天的哪次对话，只给时分不够 */
export function formatFullTime(ts: string | number | undefined): string {
  const d = ts === undefined || ts === null ? null : parseMsgDate(ts);
  if (!d) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 文件名净化：Windows 保留字符换成下划线，连续空白（含换行/制表）压成单个空格 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || '对话';
}

const ROLE_LABEL: Record<ExportMsg['role'], string> = { user: '我', assistant: '助手' };

/**
 * 组装整份对话的 Markdown。content 是消息的 Markdown 原文，**原样嵌入不加代码围栏**——
 * 围栏会把它变成代码块，用户粘贴到笔记里还得再处理一遍；嵌套围栏污染是已知取舍（原文里有 ``` 时
 * 源头格式本就由模型控制），不做二次转义。
 */
export function buildExportMarkdown(title: string, msgs: ExportMsg[], exportedAt: Date = new Date()): string {
  const head = [`# ${title.trim() || '对话'}`, '', `> 导出于 ${formatFullTime(exportedAt.toISOString())} · studentbuddy`, ''];
  const body = msgs
    .filter((m) => m.content.trim())
    .map((m) => {
      const t = m.ts ? formatFullTime(m.ts) : '';
      const when = t ? `（${t}）` : '';
      return [`## ${ROLE_LABEL[m.role]}${when}`, '', m.content.trim(), ''];
    });
  return [...head, ...body.flat()].join('\n').trimEnd() + '\n';
}

/** 组装文件名：`对话标题-20260909.md`（日期取导出时刻，重导同一天会覆盖同名文件，符合直觉） */
export function exportFilename(title: string, exportedAt: Date = new Date()): string {
  const d = exportedAt;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${sanitizeFilename(title.trim() || '对话')}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.md`;
}

/** 浏览器侧触发下载。DOM 操作，不可单测——所以它必须薄到没有任何逻辑 */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
