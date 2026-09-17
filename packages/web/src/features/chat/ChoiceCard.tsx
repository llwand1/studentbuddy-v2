/**
 * ChoiceCard — 「方案选择框」浮层卡（契约 docs/ASK-CHOICE-SPEC.md §4）。
 *
 * 形态：内联在输入框上方，**不新增 modal 基元、不加遮罩**（与 AskStyleCard 同一处置）——
 * 打断感是这类交互最大的风险，学习场景尤其如此。
 *
 * 超时语义：如实标注「不设超时」并给逃生路径文案。不做倒计时、不做自动放弃——
 * 那等于替学习者拍板（与 ai-orchestrator-v2 的同一拍板口径）。
 *
 * 图标一律自绘 SVG line-icon：本仓约定不用 emoji、不引图标字体（`components/icons.tsx` 同规）。
 */
import { useEffect, useState } from 'react';
import './choice.css'; // 自包含样式：此前漏了这行 import，真机上整卡零样式裸奔成纯文字（2026-09-17 实证修复）
import type { AskChoiceRecord } from '@sb/shared';
import { CHOICE_CUSTOM_MAX } from '@sb/shared';

export interface ChoiceReplyPayload {
  optionId?: string;
  custom?: string;
}

/** 分叉＝AI 走到岔路口 */
const ICON_BRANCH = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="3" r="1.4" />
    <path d="M8 4.4v3.1" />
    <path d="M8 7.5 4.5 11v1.6" />
    <path d="M8 7.5 11.5 11v1.6" />
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
const ICON_PEN = (
  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12h2.5L12 4.5 9.5 2 2 9.5V12z" />
  </svg>
);
const ICON_INFO = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <circle cx="6" cy="6" r="4.5" />
    <path d="M6 4v2.4M6 8.2h.01" />
  </svg>
);

export function ChoiceCard({
  request,
  onReply,
  onDismiss,
}: {
  request: AskChoiceRecord;
  onReply: (requestId: string, reply: ChoiceReplyPayload) => void;
  onDismiss: () => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);

  const pending = request.status === 'pending';
  const cancelled = request.status === 'cancelled';
  const pickedLabel =
    request.reply?.custom ??
    request.options.find((o) => o.id === request.reply?.optionId)?.label ??
    '';

  // 换了一条提问就清掉自由输入的本地状态：上一张卡没发出去的半句话不能漂到下一张
  useEffect(() => {
    setCustomOpen(false);
    setCustom('');
    setBusy(false);
  }, [request.id]);

  const reply = (r: ChoiceReplyPayload): void => {
    // 乐观锁：服务端 409 是最终裁决（并发双端点击的第二只手会被拒），这里只防手抖连点
    if (!pending || busy) return;
    setBusy(true);
    onReply(request.id, r);
  };

  return (
    <div className={`choice-card${pending ? '' : ' settled'}${cancelled ? ' cancelled' : ''}`}>
      <div className="choice-head">
        <span className={`choice-ico${pending ? '' : cancelled ? ' bad' : ' ok'}`}>
          {pending ? ICON_BRANCH : cancelled ? ICON_STOP : ICON_CHECK}
        </span>
        <span className="choice-title">
          {pending ? '需要你拍板' : cancelled ? '本次提问已作废' : '已回传 AI'}
        </span>
        {pending && <span className="choice-state">等待选择</span>}
      </div>

      <div className="choice-q">{request.question}</div>

      {pending ? (
        <>
          <div className="choice-opts">
            {request.options.map((o, i) => (
              <button
                key={o.id}
                type="button"
                className="choice-opt"
                disabled={busy}
                onClick={() => reply({ optionId: o.id })}
              >
                {/* 方框里平时是选项字母（A/B/C…），悬停该选项才切打勾——ABCD 心智一眼可辨 */}
                <span className="choice-mk">
                  <span className="choice-mk-key">{String.fromCharCode(65 + i)}</span>
                  {ICON_CHECK}
                </span>
                <span className="choice-body">
                  <span className="choice-label">{o.label}</span>
                  {o.description ? <span className="choice-desc">{o.description}</span> : null}
                </span>
              </button>
            ))}

            {/* 自定义出口（老板 2026-09-17 拍板的「D」形态）：与 AI 选项同构的方框，
                字母排在 AI 选项之后；点开后输入框内联在本盒子里，不另起一行 */}
            {request.allowCustom ? (
              <div className={`choice-opt custom${customOpen ? ' open' : ''}`}>
                <button
                  type="button"
                  className="choice-custom-head"
                  disabled={busy}
                  onClick={() => setCustomOpen(true)}
                >
                  <span className="choice-mk">
                    <span className="choice-mk-key">
                      {String.fromCharCode(65 + request.options.length)}
                    </span>
                    {ICON_PEN}
                  </span>
                  <span className="choice-body">
                    <span className="choice-label">以上都不是，自己写</span>
                  </span>
                </button>
                {customOpen ? (
                  <div className="choice-custom-row">
                    <input
                      className="choice-input"
                      value={custom}
                      maxLength={CHOICE_CUSTOM_MAX}
                      placeholder="写出你的口径，AI 会按它继续…"
                      autoFocus
                      onChange={(e) => setCustom(e.target.value)}
                      onKeyDown={(e) => {
                        // 输入法组字期间的回车是「选词确认」不是「提交」（同 ChatComposer 的处置）
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === 'Enter' && custom.trim()) reply({ custom: custom.trim() });
                        if (e.key === 'Escape') setCustomOpen(false);
                      }}
                    />
                    <button
                      type="button"
                      className="choice-send"
                      disabled={busy || !custom.trim()}
                      onClick={() => reply({ custom: custom.trim() })}
                    >
                      确认
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="choice-foot">
            {ICON_INFO}
            <span>不设超时，不选会一直等。要退出可点「停止生成」或关闭本会话——挂起的提问会一并作废，AI 不会空等。</span>
          </div>
        </>
      ) : (
        <div className="choice-done-row">
          <span>
            {cancelled
              ? `已停止等待${request.cancelReason ? `（${request.cancelReason}）` : ''}，AI 已解除阻塞。`
              : `已按你的选择继续：${pickedLabel}`}
          </span>
          <button type="button" className="choice-dismiss" onClick={onDismiss}>
            收起
          </button>
        </div>
      )}
    </div>
  );
}
