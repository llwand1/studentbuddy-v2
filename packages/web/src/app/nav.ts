/**
 * 侧栏导航常量（2026-09-21 从 `App.tsx` 拆出——`App.tsx` 正顶在 `.tsx ≤300` 红线上，
 * 底部挂 `TrialNotice` 一行都挤不出来；本仓规矩「超线就拆、不压注释换行数」，
 * 先例＝`routes/chat.ts` 从 `routes.ts` 切出）。`View` 随 NAV 一起搬来并导回 App。
 * 以下注释是 App.tsx 原文搬运，一字未改。
 */
import {
  QuizIcon,
  VsIcon,
  CardsIcon,
  NoteIcon,
  StatsIcon,
  SettingsIcon,
  FlowIcon,
  GraphIcon,
} from '../components/icons';

export type View = 'chat' | 'flow' | 'graph' | 'quiz' | 'notes' | 'terms' | 'summary' | 'settings';

/**
 * 侧栏功能列表（顺序 = 用户的主线动线）。
 * ★ 2026-09-17：「学习流」「知识图」排在最前——它们是**学习的主线**（编排怎么学 → 看学出了什么），
 *   题库/笔记/词条是素材，今日总结是回顾。新功能成组放最前，而不是塞在末尾当"附加功能"。
 * `pk` 是个**例外项**：PK 页是 `#/pk` 上的独立移动优先页面（契约 PK-SPEC §5，
 * 与主壳互不嵌套），所以它不进 `View` 联合、也不 `setView`，只改 hash 交给 `main.tsx` 换根。
 *
 * 为什么要有这一项（2026-09-13 老板实测）：「对战出题」原先只有 `#/pk` 这个手输地址，
 * 前端任何地方都点不到——功能在、入口不在，等于用户以为它不存在。
 */
export type NavKey = View | 'pk';

export const NAV: Array<{ key: NavKey; label: string; icon: typeof QuizIcon }> = [
  { key: 'flow', label: '学习流', icon: FlowIcon },
  { key: 'graph', label: '知识图', icon: GraphIcon },
  { key: 'quiz', label: '题库', icon: QuizIcon },
  { key: 'pk', label: '对战', icon: VsIcon },
  { key: 'notes', label: '笔记', icon: NoteIcon },
  { key: 'terms', label: '词条', icon: CardsIcon },
  { key: 'summary', label: '今日总结', icon: StatsIcon },
  { key: 'settings', label: '设置', icon: SettingsIcon },
];

/** PK 独立页的 hash（与 `main.tsx` 的 `isPkHash()` 同一口径） */
export const PK_HASH = '#/pk';
