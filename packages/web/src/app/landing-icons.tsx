/**
 * app/landing-icons — 落地页「icon key → 自绘 line-icon 组件」的**唯一映射点**。
 *
 * ★ 为什么单独一个小文件：`landing-data.ts` 里的数据只准存**字符串 key**（见该文件头注），
 *   而组件必须从 `components/icons.tsx` 拿 ⇒ 中间必须有一处把两者接起来。
 *   若让 `LandingIntro` 和 `LandingFeatures` 各接一份，**新增一个图标就要改两处、漏一处就变 undefined**
 *   （同 RefList / ReviewPanel 的先例），故收敛到本文件，两个组件共用同一张表。
 *
 * ★ 用 `Record<LandingIconKey, …>` 而不是 `Partial<Record<…>>`：**漏登记一个 key 必须是编译错误**，
 *   而不是运行时渲染出一个空位（这也是本仓 `FLOW_STEP_METAS` / `LANDING_DEMOS` 的一贯口径：
 *   「有限清单必须闭环，缺一个就在编译期炸，不许留到运行时」）。

 * ★ key 的联合类型在 `landing-data.ts`（那里不能 import 组件），本文件是它的**唯一兑现处**。
 */
import {
  CardsIcon,
  ChatIcon,
  CheckIcon,
  DocIcon,
  FlowIcon,
  GraphIcon,
  NoteIcon,
  QuizIcon,
  SearchIcon,
  StatsIcon,
  VsIcon,
} from '../components/icons';
import type { LandingIconMap } from './landing-data';

export const LANDING_ICONS: LandingIconMap = {
  chat: ChatIcon,
  quiz: QuizIcon,
  stats: StatsIcon,
  cards: CardsIcon,
  check: CheckIcon,
  flow: FlowIcon,
  graph: GraphIcon,
  vs: VsIcon,
  note: NoteIcon,
  search: SearchIcon,
  doc: DocIcon,
};
