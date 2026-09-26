/**
 * 侧栏导航常量（2026-09-21 从 `App.tsx` 拆出——`App.tsx` 正顶在 `.tsx ≤300` 红线上，
 * 底部挂 `TrialNotice` 一行都挤不出来；本仓规矩「超线就拆、不压注释换行数」，
 * 先例＝`routes/chat.ts` 从 `routes.ts` 切出）。`View` 随 NAV 一起搬来并导回 App。
 * 以下注释是 App.tsx 原文搬运，一字未改。
 */
import { VsIcon, CardsIcon, SettingsIcon } from '../components/icons';

export type View = 'chat' | 'terms' | 'settings';

/**
 * 侧栏功能列表（顺序 = 用户的主线动线）。
 * ★ 2026-09-25：「学习流」「知识图」两项随功能整体下线删除（批次 K，老板判决：联动性太低）。
 * ★ 2026-09-25：「笔记」「今日总结」两项同批下线（老板判决：无人使用）——
 *   砍的是**入口与页面**，XP/连签的台账在服务端照旧在记（`learning/activity.ts`）。
 * ★ 2026-09-26：「题库」项同族下线（老板判决逐字：「题库功能也去删了，现在只要剩下内核和对战以及词条」）——
 *   这一项砍的也是**页面与列表**，不是「出题」这件能力：对话里的题卡、输入框的「出题」、
 *   以及对战出题用的那台引擎（`learning/quiz.ts`）全在，理由与代价见 CHANGELOG 本批行与 `docs/QUIZ-WEAK-SPEC.md` 墓碑。
 * `pk` 是个**例外项**：PK 页是 `#/pk` 上的独立移动优先页面（契约 PK-SPEC §5，
 * 与主壳互不嵌套），所以它不进 `View` 联合、也不 `setView`，只改 hash 交给 `main.tsx` 换根。
 *
 * 为什么要有这一项（2026-09-13 老板实测）：「对战出题」原先只有 `#/pk` 这个手输地址，
 * 前端任何地方都点不到——功能在、入口不在，等于用户以为它不存在。
 */
export type NavKey = View | 'pk';

export const NAV: Array<{ key: NavKey; label: string; icon: typeof VsIcon }> = [
  { key: 'pk', label: '对战', icon: VsIcon },
  { key: 'terms', label: '词条', icon: CardsIcon },
  { key: 'settings', label: '设置', icon: SettingsIcon },
];

/** PK 独立页的 hash（与 `main.tsx` 的 `isPkHash()` 同一口径） */
export const PK_HASH = '#/pk';
