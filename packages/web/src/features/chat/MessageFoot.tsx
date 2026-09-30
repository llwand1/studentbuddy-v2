/**
 * MessageFoot —— 单条消息下方的时间戳 + 操作（复制 / 重新生成 / 资料 n 条 / 找视频）。
 * 抽出来是为了守 web 组件 ≤300 行的红线（ChatView 已 267 行），也因为这两个动作
 * 各自的失败形态（剪贴板不可用、生成中禁点）不该塞进消息渲染的主干里。
 *
 * 「找视频」（2026-09-30，SOURCE-TRACE-SPEC §12）：每条回答都有——不要求它联过网；提问那一行不挂（一问一答挂两个
 * 是噪音，答案行的种子更准）。种子词优先取 AI 这轮的搜索词（架上任一条的 `query`），没有就从回答正文推一个
 * （第一个标题 / 首句），学习者在面板里随时改。
 */
import { useState } from 'react';
import { videoQueryFromText, type SourceItem } from '@sb/shared';
import { formatMsgTime } from './chat-meta';
import { openSources } from '../../lib/sources-store';
import { openVideoRoute } from '../../lib/video-route-store';
import './chat-extras.css';

export function MessageFoot({
  ts,
  content,
  canRegen = false,
  regenDisabled = false,
  onRegen,
  sessionId = '',
  sources,
  canVideos = false,
}: {
  ts?: string;
  content: string;
  canRegen?: boolean;
  regenDisabled?: boolean;
  onRegen?: () => void;
  /** 资料溯源（SOURCE-TRACE-SPEC §8）：这条回答挂的资料架；有则出「资料 n 条」，点开右侧面板 */
  sessionId?: string;
  sources?: SourceItem[];
  /** 视频线路（§12）：只有回答行为 true；还得有会话 id（面板按会话记状态） */
  canVideos?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const time = formatMsgTime(ts);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用（非安全上下文/无权限）：静默，正文仍可手动选取复制 */
    }
  };

  return (
    <div className="msg-foot">
      {time && <span className="msg-time">{time}</span>}
      <button type="button" className="msg-act" onClick={() => void copy()}>
        {copied ? '已复制' : '复制'}
      </button>
      {canRegen && (
        <button type="button" className="msg-act" disabled={regenDisabled} onClick={onRegen}>
          重新生成
        </button>
      )}
      {sources && sources.length > 0 && (
        <button
          type="button"
          className="msg-act msg-sources"
          title="在右侧打开这条回答参考的资料"
          onClick={() => openSources(sessionId, sources)}
        >
          资料 {sources.length} 条
        </button>
      )}
      {canVideos && sessionId && (
        <button
          type="button"
          className="msg-act msg-videos"
          title="去 B站 / 抖音找这个知识点的讲解视频（B站就地播，抖音跳转看）"
          onClick={() => openVideoRoute(sessionId, sources?.find((s) => s.query)?.query ?? videoQueryFromText(content))}
        >
          找视频
        </button>
      )}
    </div>
  );
}
