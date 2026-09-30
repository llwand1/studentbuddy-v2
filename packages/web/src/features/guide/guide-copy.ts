/**
 * guide-copy —— 引路灯**界面框架文案**的双语收编点（中英成对，同 `app/shell-copy.ts` 的做法：
 * 组件里不留中文字面量，漏译在 review 时一眼可见；`guide-copy.test.ts` 遍历全表查「半成品」）。
 *
 * 范围：只有提灯与弹层的框架文案。各动作的标签 / 副行 / 「怎么解锁」在 `@sb/shared` 的 `GUIDE_CATALOG`
 * （服务端校验器也要用同一份）；AI 写的文案按请求里的 `lang` 写。
 */
import type { GuideReason } from '@sb/shared';
import type { Bi } from '../../app/landing-lang';

export const GUIDE_COPY = {
  /** 提灯按钮的 aria-label / 悬停提示 */
  label: { zh: '下一步做什么？', en: "What's next?" },
  title: { zh: '引路灯', en: 'Guiding lantern' },
  badgeAi: { zh: 'AI 现挑', en: 'AI-picked' },
  badgeRules: { zh: '常用建议', en: 'Quick picks' },
  badgeLoading: { zh: 'AI 正在想…', en: 'AI is thinking…' },
  refresh: { zh: '换一批', en: 'Refresh' },
  fresher: { zh: '有新建议 ↻', en: 'New picks ↻' },
  close: { zh: '收起', en: 'Close' },
  allFeatures: { zh: '全部功能', en: 'All features' },
  proactive: { zh: '主动提示', en: 'Proactive hints' },
  proactiveTitle: { zh: '关键时刻让提灯自己亮起来；关掉后只在你点开时才出声', en: 'Let the lantern light up at key moments; off = it only speaks when opened' },
  escHint: { zh: 'Esc 收起', en: 'Esc to close' },
  unavailable: { zh: '这一步现在做不了，换一项试试', en: "Can't do that right now — try another" },
  /** 选项的悬停提示：会以用户身份发出的那句话 */
  willSend: { zh: '会发送：', en: 'Will send: ' },
  /** 没有推荐项（忙态）时的占位 */
  nothingYet: { zh: '稍等片刻…', en: 'One moment…' },
} satisfies Record<string, Bi>;

/** 规则推荐的原因（机器码 → 人话）；`failed` 是连服务都没联系上 */
export const GUIDE_REASON_COPY: Record<GuideReason | 'failed', Bi> = {
  'no-model': { zh: '还没有可用的模型，先给你常用建议', en: 'No model available yet — showing quick picks' },
  timeout: { zh: '模型没在时限内回话，先给你常用建议', en: 'The model timed out — showing quick picks' },
  aborted: { zh: '这次请求被中断了，先给你常用建议', en: 'That request was interrupted — showing quick picks' },
  upstream: { zh: '模型这次没接上，先给你常用建议', en: 'Could not reach the model — showing quick picks' },
  parse: { zh: '模型这次的回答不合格，先给你常用建议', en: "The model's answer was unusable — showing quick picks" },
  failed: { zh: '没能联系上服务，先给你常用建议', en: "Couldn't reach the server — showing quick picks" },
};
