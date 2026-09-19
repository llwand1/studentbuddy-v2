/**
 * api-tools — 工具生态的前端读写口（契约 docs/TOOL-ECOSYSTEM-SPEC.md §6.3-4 阈值、§4.5 统计、§6.4 回执）。
 *
 * 单开文件的原因同 api-auth / api-terms-domain：api.ts 贴 400 行红线（AGENTS 行数口径），
 * 且这批形状（ToolStatSummary 等）只有设置页「工具」卡与词条撤销条消费，集中一处好对齐。
 * 类型是**服务端口径的手抄镜像**（storage/tool-stats.ts、storage/term-delete-log.ts）——
 * 没放 shared 是因为契约 v1.2 立项时就这样对齐 sse-events 之外的窄口径；漂了由路由测试兜底。
 */
import type { ToolConfirmDecision } from '@sb/shared';
import { request } from './api-request.js';

export type { ToolConfirmDecision };

/** 每工具 30 天聚合行（`summarizeToolStats` 的形状） */
export interface ToolStatSummary {
  tool: string;
  source: 'builtin' | 'mcp';
  calls: number;
  failures: number;
  p95Ms: number;
  affectedTotal: number;
  confirmAllowed: number;
  confirmDenied: number;
}

export interface ToolStatsResponse {
  stats: ToolStatSummary[];
  deleteLogTotal: number;
  /** 带 sessionId 且归属通过才有值：本会话 AI 累计改动条数（§4.6 绕过面审计） */
  sessionAffected: number | null;
}

/** 可撤销删除批次（词条页撤销条数据源，GET /api/terms/delete-batches） */
export interface UndoableBatch {
  batch: string;
  count: number;
  actor: 'ai_tool' | 'ui';
  tool: string | null;
  createdAt: string;
}

/** 撤销结果：冲突不算失败，如实报「还原 N、撞名 M」 */
export interface UndoResult {
  restored: number;
  conflicts: string[];
}

export const toolsApi = {
  /** 确认阈值（1=每次都问 / 5=默认 / 0=从不等；服务端归一，坏值回退默认不 400） */
  confirmThreshold: () => request<{ threshold: number }>('/api/tools/confirm-threshold'),
  saveConfirmThreshold: (threshold: number) =>
    request<{ ok: boolean; threshold: number }>('/api/tools/confirm-threshold', {
      method: 'PUT',
      body: JSON.stringify({ threshold }),
    }),
  stats: (sessionId?: string) =>
    request<ToolStatsResponse>(
      `/api/tools/stats${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
    ),
  /** 确认卡回执：400 非法裁决 / 404 不存在或已过期 / 409 已有裁决（服务端是最终裁决） */
  replyConfirm: (requestId: string, decision: ToolConfirmDecision) =>
    request<{ ok: boolean }>('/api/chat/tool-confirm', {
      method: 'POST',
      body: JSON.stringify({ requestId, decision }),
    }),
};

export const termsUndoApi = {
  undoableBatches: () => request<UndoableBatch[]>('/api/terms/delete-batches'),
  undoDelete: (batch: string) =>
    request<UndoResult>('/api/terms/undo-delete', { method: 'POST', body: JSON.stringify({ batch }) }),
};
