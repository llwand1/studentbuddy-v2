/**
 * chat/options — 单轮对话的**出入参契约**（`handleMessage` 的签名）。
 *
 * 2026-09-18 从 `chat/flow.ts` 拆出：加完多租户 `ownerId` 后该文件涨到 405 行，
 * 触 AGENTS.md「.ts ≤400 行」红线。按本仓既有规矩（**按职责切文件，不压注释换行数**）：
 * `flow.ts` 装的是「这一轮**怎么跑**」的编排，本文件只是「这一轮的输入输出**长什么样**」，
 * 而且两者的读者不同——路由层（`routes/chat.ts`）只关心本文件。
 */
import type { ModelRole } from '@sb/shared';
import type { UploadedImage } from '../llm/types.js';

export interface ChatOptions {
  sessionId: string;
  text: string;
  role?: ModelRole;
  signal?: AbortSignal;
  /** v17 看图：用户上传的图片（base64 dataURL 内联）。非空时先蒸馏成文字描述再进主模型上下文 */
  images?: UploadedImage[];
  /** 重新生成：提问已在库里，跳过 user 落库（否则一轮出现两条相同提问） */
  skipUserPersist?: boolean;
  /** v18 grill-me（见 `chat/grill.ts`）：本轮必出选择框——开场问方向（答复回灌）＋收尾问下一步（不等待） */
  grillMe?: boolean;
  /** v18.4 联网开关（UI「联网已开」pill）：打开则**首轮**强绑 search_web，turn 1 起放开（见 `chat/opening.ts`） */
  online?: boolean;
  /**
   * 归属用户 id（多租户，契约 `docs/TENANCY-SPEC.md` §7）。未登录 → `null`（本地单人模式，不过滤）。
   * ★ 为什么必须显式传：本链路是 **fire-and-forget** 的，压缩与记忆写入发生在 HTTP 响应之后，
   *   那时已无 `req` 可取的上下文——不传下来，画像就只能写成无主行、或串到别人名下。
   */
  ownerId?: string | null;
}

export interface ChatResult {
  ok: boolean;
  error?: string;
  assistantMessageId?: string;
}
