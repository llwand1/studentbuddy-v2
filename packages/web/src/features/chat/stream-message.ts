/** Persisted/live message shape. Kept separate from the stream lifecycle and re-exported by useChatStream. */
import type { ReplyPracticeRef, SourceItem, TaskItem } from '@sb/shared';
import type { ToolStep } from './step-fold';
import type { QuizBlockView, ScenarioBlockView } from './chat-blocks';

export interface StreamMessage {
  replyPractice?: ReplyPracticeRef;
  role: 'user' | 'assistant';
  content: string;
  /** 消息时间：历史消息取库内 created_at（SQLite UTC 串），本轮新消息取本地 ISO */
  ts?: string;
  streaming?: boolean;
  /** v17 看图：用户上传的图片（base64 dataURL），仅用于气泡内缩略图回显 */
  images?: Array<{ dataUrl: string; name?: string }>;
  quizBlock?: QuizBlockView;
  /** 情景题卡片（契约 SCENARIO-SPEC §8）：live 走 block 事件、历史由 chat-blocks 还原 */
  scenarioBlock?: ScenarioBlockView;
  /**
   * 这条回答的执行过程（工具卡片）。★ 归属到消息而非页面：
   * 历史消息由 history-fold 从库里重建（tool_calls 展开 + tool 结果回填），
   * 本轮消息由 step 事件累积、在 done 时归并进来。正文为空但有 steps 的消息同样要渲染
   * （纯工具轮 / 被停止的半轮），否则过程又丢了。
   */
  steps?: ToolStep[];
  /** 这条回答的思考链原文（v11 起落库；历史由 history-fold 读列、本轮由 done 归并） */
  reasoning?: string;
  /** 本轮思考耗时（服务端实测）：done 帧带来、历史读 `thinking_ms` 列——两者同源（§4.7） */
  thinkingMs?: number;
  /** 这条回答最终声明的任务清单（同上；update_tasks 是全量覆盖语义） */
  tasks?: TaskItem[];
  sources?: SourceItem[]; // 资料溯源（SOURCE-TRACE-SPEC §8）：done 时由 sources-store 归位、历史读 `sources` 列
}

