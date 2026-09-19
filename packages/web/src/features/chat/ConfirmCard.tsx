/**
 * ConfirmCard — 工具确认门浮层卡（契约 docs/TOOL-ECOSYSTEM-SPEC.md §6.3-4/§6.4，P3）。
 *
 * 形态仿 ChoiceCard：内联在输入框上方、不新增 modal、不加遮罩；样式复用 choice.css 的
 * 卡壳与页脚基元，只补 `.confirm-*` 几类（同一处置口径：不新造视觉语言）。
 *
 * §5.1 四条硬要求逐条落位，缺一条这卡就不许上线：
 * ① `actionSummary` 动作一句话 ② `affected` 条数 ③ `items` 具体清单 ④「拒绝后 AI 不会
 * 重复发起」的说明（页脚，与 60s 超时同口径）。
 *
 * 倒计时是**显示件不是裁决件**：到期由服务端定时器代答 timeout（单一裁决者），
 * 前端归零只切「正在按拒绝收口」文案，绝不本地判死或重发。
 *
 * 图标一律自绘 SVG line-icon（本仓约定不用 emoji，同 ChoiceCard）。
 */
import { useEffect, useState } from 'react';
import './choice.css';
import type { ToolConfirmDecision } from '@sb/shared';
import { toolLabel } from './chat-meta';
import type { ConfirmItem } from './useConfirmQueue';

/** 已裁决态一句话（结果如实念，不粉饰也不吓唬） */
export function confirmResultText(decision: ToolConfirmDecision): string {
  switch (decision) {
    case 'allow_once':
      return '已允许，AI 正按批准的方案继续。';
    case 'allow_session':
      return '已允许，本会话内同工具的同类改动不再询问。';
    case 'deny':
      return '已拒绝，AI 不会重复发起，只会把建议用文字告诉你。';
    case 'timeout':
      return '60 秒未裁决，已按拒绝处理（保守收口），AI 不会重复发起。';
  }
}

const ICON_DOOR = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 13.5V3.2L9.2 2v11.3" />
    <path d="M2 13.5h12.5" />
    <circle cx="7.4" cy="8" r="0.7" fill="currentColor" stroke="none" />
  </svg>
);
const ICON_CHECK = (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 6.5 4.6 9 10 3.5" />
  </svg>
);
const ICON_STOP = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <circle cx="6" cy="6" r="4.5" />
    <path d="M4 6h4" />
  </svg>
);
const ICON_INFO = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <circle cx="6" cy="6" r="4.5" />
    <path d="M6 4v2.4M6 8.2h.01" />
  </svg>
);

export function ConfirmCard({
  request,
  now,
  onReply,
  onDismiss,
}: {
  request: ConfirmItem;
  /** 当前时刻（ms）：由外层每秒推进——计时器只留一份，卡片是纯渲染件、好上测 */
  now: number;
  onReply: (requestId: string, decision: ToolConfirmDecision) => void;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const pending = request.decision === null;
  const remainMs = pending ? Math.max(0, request.expiresAt - now) : 0;

  // 换一张卡就松开本地锁：上一张点了没等到广播的 busy 不能漂到下一张（同 ChoiceCard 的处置）
  useEffect(() => {
    setBusy(false);
  }, [request.requestId]);

  const reply = (decision: ToolConfirmDecision): void => {
    // busy 只防手抖连点；最终裁决是服务端广播的 tool-confirm-resolved（409 兜并发）
    if (!pending || busy) return;
    setBusy(true);
    onReply(request.requestId, decision);
  };

  const who = request.source === 'mcp' ? `MCP · ${request.server ?? '未知来源'} · ${request.tool}` : toolLabel(request.tool);

  return (
    <div className={`choice-card confirm${pending ? '' : ' settled'}`}>
      <div className="choice-head">
        <span className={`choice-ico${pending ? '' : request.decision === 'allow_once' || request.decision === 'allow_session' ? ' ok' : ' bad'}`}>
          {pending ? ICON_DOOR : request.decision === 'deny' || request.decision === 'timeout' ? ICON_STOP : ICON_CHECK}
        </span>
        <span className="choice-title">{pending ? 'AI 想执行改动，等你批准' : '本次确认已收口'}</span>
        {pending ? (
          <span className={`choice-state${remainMs === 0 ? ' expired' : ''}`}>
            {remainMs > 0 ? `剩 ${Math.ceil(remainMs / 1000)} 秒` : '正在按拒绝收口…'}
          </span>
        ) : null}
      </div>

      <div className="choice-q">{request.actionSummary}</div>

      <div className="confirm-meta">
        <span className="confirm-who">{who}</span>
        <span className="confirm-count">影响 {request.affected} 条</span>
      </div>

      {request.items.length > 0 ? (
        <ul className="confirm-items">
          {request.items.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      {pending ? (
        <>
          <div className="confirm-btns">
            <button type="button" className="confirm-btn ok" disabled={busy} onClick={() => reply('allow_once')}>
              允许这一次
            </button>
            <button type="button" className="confirm-btn ghost" disabled={busy} onClick={() => reply('allow_session')}>
              本会话内允许
            </button>
            <button type="button" className="confirm-btn bad" disabled={busy} onClick={() => reply('deny')}>
              拒绝
            </button>
          </div>
          <div className="choice-foot">
            {ICON_INFO}
            <span>拒绝或 60 秒未裁决，AI 都不会重复发起，只会把建议用文字告诉你；批准也只放行这一次列出的改动。</span>
          </div>
        </>
      ) : (
        <div className="choice-done-row">
          <span>{request.decision ? confirmResultText(request.decision) : ''}</span>
          <button type="button" className="choice-dismiss" onClick={onDismiss}>
            收起
          </button>
        </div>
      )}
    </div>
  );
}
