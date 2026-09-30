/**
 * 侧栏导航常量（2026-09-21 从 `App.tsx` 拆出——`App.tsx` 正顶在 `.tsx ≤300` 红线上，
 * 底部挂 `TrialNotice` 一行都挤不出来；本仓规矩「超线就拆、不压注释换行数」，
 * 先例＝`routes/chat.ts` 从 `routes.ts` 切出）。`View` 随 NAV 一起搬来并导回 App。
 * 以下注释是 App.tsx 原文搬运，一字未改。
 */
import { VsIcon, CardsIcon, GraphIcon, SettingsIcon } from '../components/icons';
import type { Bi } from './landing-lang';

export type View = 'chat' | 'terms' | 'continent' | 'settings';

/**
 * 侧栏功能列表（顺序 = 用户的主线动线）。
 * ★ 「学习流」「知识图」两项随功能整体下线删除（联动性太低）。
 * ★ 「笔记」「今日总结」两项一并下线（无人使用）——
 *   砍的是**入口与页面**，XP/连签的记录在服务端照旧在记（`learning/activity.ts`）。
 * ★ 「题库」项同族下线（只要剩下内核、对战和词条）——
 *   这一项砍的也是**页面与列表**，不是「出题」这件能力：对话里的题卡、输入框的「出题」、
 *   以及对战出题用的那台引擎（`learning/quiz.ts`）全在，理由与代价见改动记录与 `docs/QUIZ-WEAK-SPEC.md` 墓碑。
 * `pk` 是个**例外项**：PK 页是 `#/pk` 上的独立移动优先页面（契约 PK-SPEC §5，
 * 与主壳互不嵌套），所以它不进 `View` 联合、也不 `setView`，只改 hash 交给 `main.tsx` 换根。
 *
 * 为什么要有这一项：「对战出题」原先只有 `#/pk` 这个手输地址，
 * 前端任何地方都点不到——功能在、入口不在，等于用户以为它不存在。
 */
export type NavKey = View | 'pk';

/**
 * 标签是 `Bi`（{zh,en}）：2026-09-28 全局中英切换起跟着语言走（消费方只有 `App.tsx` 一处，
 * 那里 `label[lang]` 取词）。放在本文件而不是 `shell-copy.ts`：`NAV` 是导航数据本身，
 * 标签跟着它走最直观，也免了 `shell-copy ↔ nav` 的循环 import。
 */
export const NAV: Array<{ key: NavKey; label: Bi; icon: typeof VsIcon }> = [
  { key: 'pk', label: { zh: '对战', en: 'Vs AI' }, icon: VsIcon },
  { key: 'terms', label: { zh: '词条', en: 'Terms' }, icon: CardsIcon },
  { key: 'continent', label: { zh: '知识大陆', en: 'Continent' }, icon: GraphIcon },
  { key: 'settings', label: { zh: '设置', en: 'Settings' }, icon: SettingsIcon },
];

/** PK 独立页的 hash（与 `main.tsx` 的 `isPkHash()` 同一口径） */
export const PK_HASH = '#/pk';
