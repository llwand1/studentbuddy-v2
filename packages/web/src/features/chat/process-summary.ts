/**
 * process-summary —— 收口后过程区的一行摘要（v13 体验升级 P0）。
 *
 * 问题：done 归并后思考/任务/工具卡片全量铺在回答上方，长对话里过程区喧宾夺主；
 * 主流（Claude/Manus/豆包）收口后把过程折成一行摘要，点开才展开。
 * 本文件只产文案（纯函数可测），折叠/展开交互在 MessageRow。
 */

export interface ProcessShape {
  reasoning?: string;
  tasks?: unknown[];
  steps?: Array<{ tool: string }>;
}

/** 工具名 → 用户视角动作（与 chat/tools.ts 注册表对应；未知工具名原样展示） */
const TOOL_LABELS: Record<string, string> = {
  search_web: '联网搜索',
  tidy_terms: '整理词条库',
  manage_terms: '维护词条库',
  update_tasks: '规划任务',
};

/** 思考链超过这个字数才显示字数（几十字的思考报「已深度思考（0.1k 字）」是噪音） */
const REASONING_COUNT_MIN = 1000;

export function processSummary(p: ProcessShape): string {
  const parts: string[] = [];
  if (p.reasoning) {
    parts.push(
      p.reasoning.length >= REASONING_COUNT_MIN
        ? `已深度思考（${(Math.round(p.reasoning.length / 100) / 10).toFixed(1)}k 字）`
        : '已深度思考',
    );
  }
  if (p.steps && p.steps.length > 0) {
    // 同工具多次调用合并计数（搜索 3 次比三个同名芯片折叠得更像一行话）
    const counts = new Map<string, number>();
    for (const s of p.steps) counts.set(s.tool, (counts.get(s.tool) ?? 0) + 1);
    for (const [tool, n] of counts) {
      const label = TOOL_LABELS[tool] ?? tool;
      parts.push(n > 1 ? `${label} ×${n}` : label);
    }
  }
  if (p.tasks && p.tasks.length > 0) parts.push(`任务清单 ${p.tasks.length} 项`);
  return parts.join(' · ') || '查看过程';
}
