/**
 * AskStyleCard — 出题前的「先问一次」选项卡（契约 docs/ANSWER-STYLE-SPEC.md §4）。
 * 内联在按钮上方，不新增 modal 基元、不加遮罩：打断感是这套功能最大的风险。
 * useAskStyle 把「configured 判定 / 勾了记住就顺手 PUT / 单次覆盖」收在一处，
 * 聊天页与题库页共用同一套流程——两页各写一遍必然漂成两种行为（本仓的老账）。
 */
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_ANSWER_STYLE, styleSummary } from '@sb/shared';
import type { AnswerStyle } from '@sb/shared';
import { api } from '../../lib/api';
import { StyleChips } from '../../components/StyleChips';
import './ask-style.css';

export function AskStyleCard({
  value,
  onValue,
  remember,
  onRemember,
  busy,
  onConfirm,
  onSkip,
  onClose,
}: {
  value: AnswerStyle;
  onValue: (next: AnswerStyle) => void;
  remember: boolean;
  onRemember: (v: boolean) => void;
  busy?: boolean;
  onConfirm: () => void;
  onSkip: () => void;
  onClose: () => void;
}) {
  return (
    <div className="ask-style">
      <div className="ask-style-head">
        <span>出题前先定一下：你喜欢怎么被回答？</span>
        <button className="ask-style-close" type="button" onClick={onClose}>
          收起
        </button>
      </div>

      <StyleChips value={value} onChange={onValue} disabled={busy} />

      <label className="ask-style-remember">
        <input type="checkbox" checked={remember} disabled={busy} onChange={(e) => onRemember(e.target.checked)} />
        记住，以后别问了（存进设置 › 回答方式偏好，随时可改）
      </label>

      <div className="ask-style-actions">
        <button className="ask-style-btn primary" type="button" disabled={busy} onClick={onConfirm}>
          {remember ? '就按这个出题并记住' : '就按这个出题'}
        </button>
        <button className="ask-style-btn" type="button" disabled={busy} onClick={onSkip}>
          别问了，直接出
        </button>
      </div>
    </div>
  );
}

type AskState = { loaded: boolean; configured: boolean; style: AnswerStyle; remember: boolean; open: boolean };

export function useAskStyle(run: (style?: AnswerStyle) => void) {
  // configured 初值 true：读取还没回来时按「配过」处理——宁可少问一次，也不在出题路上插队
  const [ask, setAsk] = useState<AskState>({
    loaded: false,
    configured: true,
    style: DEFAULT_ANSWER_STYLE,
    remember: true,
    open: false,
  });

  useEffect(() => {
    api.settings
      .answerStyle()
      .then((r) => setAsk((s) => ({ ...s, loaded: true, configured: r.configured, style: r.style })))
      .catch(() => setAsk((s) => ({ ...s, loaded: true })));
  }, []);

  /** 落库并回读归一后的值；存失败也照常出题（本次覆盖照样生效），只是下次还会问 */
  const persist = useCallback(async (style: AnswerStyle) => {
    try {
      const r = await api.settings.saveAnswerStyle(style);
      setAsk((s) => ({ ...s, configured: true, style: r.style, open: false }));
      return r.style;
    } catch {
      return style;
    }
  }, []);

  /** 点「出题」：配过就直接跑；没配过则展开选项卡，本次不出题 */
  const tap = useCallback(() => {
    if (ask.configured) run();
    else setAsk((s) => ({ ...s, open: true }));
  }, [ask.configured, run]);

  const confirm = useCallback(async () => {
    const next = ask.remember ? await persist(ask.style) : ask.style;
    setAsk((s) => ({ ...s, open: false }));
    run(next);
  }, [ask.remember, ask.style, persist, run]);

  const skip = useCallback(async () => {
    run(await persist(DEFAULT_ANSWER_STYLE));
  }, [persist, run]);

  const card = ask.open
    ? {
        value: ask.style,
        onValue: (style: AnswerStyle) => setAsk((s) => ({ ...s, style })),
        remember: ask.remember,
        onRemember: (remember: boolean) => setAsk((s) => ({ ...s, remember })),
        onConfirm: () => void confirm(),
        onSkip: () => void skip(),
        onClose: () => setAsk((s) => ({ ...s, open: false })),
      }
    : null;

  return {
    tap,
    card,
    /** 已配过才显示摘要；没配过时摘要没意义（屏上预选的不算已配置） */
    summary: ask.configured ? styleSummary(ask.style) : '',
    /** 对话发送不弹卡，只轻提一次路（契约 §4 末段） */
    hint: ask.loaded && !ask.configured ? '还没告诉过 AI 你喜欢怎么被回答——点「出题」会先问一次，也可去设置 › 回答方式偏好' : '',
  };
}
