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
} from '../components/icons';
import { SparkleIcon } from '../components/game-icons';

export type View = 'chat' | 'quiz' | 'notes' | 'terms' | 'cards' | 'summary' | 'settings';

/**
 * 侧栏功能列表（顺序 = 用户的主线动线）。
 * ★ 2026-09-25：「学习流」「知识图」两项随功能整体下线删除（批次 K，老板判决：联动性太低）。
 * `pk` 是个**例外项**：PK 页是 `#/pk` 上的独立移动优先页面（契约 PK-SPEC §5，
 * 与主壳互不嵌套），所以它不进 `View` 联合、也不 `setView`，只改 hash 交给 `main.tsx` 换根。
 *
 * 为什么要有这一项（2026-09-13 老板实测）：「对战出题」原先只有 `#/pk` 这个手输地址，
 * 前端任何地方都点不到——功能在、入口不在，等于用户以为它不存在。
 *
 * ★ 2026-09-25 新增「卡牌」（`cards`，契约 TERM-CARDS-SPEC §7）：卡墙／每日宝箱／任务清单
 *   三屏合一的入口，紧挨「词条」放——那两屏看的是**同一批词条**，一个按领域列表、一个按卡牌陈列。
 *   图标取游戏集的 `SparkleIcon`（`game-icons.tsx` 文件头的分工：产品分区归 `icons.tsx`、
 *   游戏物件归这里）。
 * ⚠️ 这一项**不挂待办数徽标**：清单读数住在 `CardsView` 自己的那条 SSE 订阅里，页没挂载就没有数。
 *   要在侧栏常显得先把 `/api/cards/state` 提到全局壳——那是另一件事，写在这里是为了别把它当坏了。
 */
export type NavKey = View | 'pk';

export const NAV: Array<{ key: NavKey; label: string; icon: typeof QuizIcon }> = [
  { key: 'quiz', label: '题库', icon: QuizIcon },
  { key: 'pk', label: '对战', icon: VsIcon },
  { key: 'notes', label: '笔记', icon: NoteIcon },
  { key: 'terms', label: '词条', icon: CardsIcon },
  { key: 'cards', label: '卡牌', icon: SparkleIcon },
  { key: 'summary', label: '今日总结', icon: StatsIcon },
  { key: 'settings', label: '设置', icon: SettingsIcon },
];

/** PK 独立页的 hash（与 `main.tsx` 的 `isPkHash()` 同一口径） */
export const PK_HASH = '#/pk';
