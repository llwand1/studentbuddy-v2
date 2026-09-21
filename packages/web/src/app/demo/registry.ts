/**
 * landing 演示 —— 落地页「过程式演示动画」的**装配点**。
 *
 * ★ 为什么单独抽一层：老板 2026-09-20 定「先只上词条演示，知识图等准备好之后再落地」。
 *   故把「一个演示」拆成 **帧序列 stages + 帧渲染器 View** 两件事：
 *   新增演示 = 新写一个 View + 往 `LANDING_DEMOS` 追加一项 ⇒ 外壳/播放器零改动
 *   （样式是要按需加一段的，当初把「样式」也写成零改动是嘴硬，2026-09-21 对战批改正）。
 *   ★ 这句"以后再说的空话"已在**同日知识图批兑现**：追加 `GRAPH_FLOW` 时
 *     `LandingDemo.tsx` 与 `useDemoPlayer.ts` 确实一行未改，多演示的 Tab 也自动出现
 *     （切换位早就留好：只有 1 个演示时刻意不画 Tab）。
 *
 * ★ 帧只读 `stage` 序号，**帧内动画一律走 CSS**（`demo.css` 的 keyframes/transition）。
 *   JS 只承担一件必须逐帧推进的事：打字机。它也是 `setTimeout` 而非补间库 ——
 *   AGENTS.md「刻意不引库」是明文纪律（前端零第三方库，动画同理）。
 *
 * ★ 帧时长刻意写死而非"动画跑完自动跳"：CSS 动画没有可靠的回调，用 `animationend` 会与
 *   切帧竞态（同一元素连播两次时可能丢事件）。固定时长是唯一确定性的做法，代价是
 *   打字机帧的时长必须 ≥ 文本揭示耗时（已按 25 字 × 42ms + 尾停留核算，见 TermFlowDemo）。
 */
import type { ComponentType } from 'react';
import { TermFlowDemo } from './TermFlowDemo';
import { GraphDemo } from './GraphDemo';
import { PkFlowDemo } from './PkFlowDemo';

export type DemoStage = {
  /** 底部阶段条的说明文案（一帧一句） */
  caption: string;
  /** 本帧停留时长(ms) */
  ms: number;
};

export type DemoDefinition = {
  key: string;
  /** 演示窗标题栏文案 */
  title: string;
  stages: DemoStage[];
  /** 帧渲染器：只读 stage，不持有自己的计时器 */
  View: ComponentType<{ stage: number }>;
};

/** 词条流程演示：对话抽词 → 高亮 → 悬浮卡 → 入库 → 复习翻牌 */
export const TERM_FLOW: DemoDefinition = {
  key: 'term-flow',
  title: '对话 · 词条',
  stages: [
    { caption: '对话进行中：词条库里已有的词自动标出来', ms: 3800 },
    { caption: '悬停出速览卡：释义、领域、已用次数', ms: 2400 },
    { caption: '回复结束自动入库，不打断对话', ms: 1900 },
    { caption: '到期自动进复习队列：先翻牌自测', ms: 2300 },
    { caption: '翻牌看释义与进度：1/2/4/7/15/30/60 天', ms: 3800 },
  ],
  View: TermFlowDemo,
};

/**
 * 知识图演示：对词条「向 AI 追问」→ 独立会话 → 回复抽出的词条自动连回源词条
 * ⇒ 星型；再追一层 ⇒ 树；末帧讲「AI 抽的边未经确认，确认一次才转正」。
 *
 * ★ 排在词条演示**之后**：词条是机制（这一套的源头），知识图是**产物**。
 *   先看"词从哪来"再看"词怎么连起来"，顺序反了会让人以为图是凭空生成的。
 */
export const GRAPH_FLOW: DemoDefinition = {
  key: 'graph-flow',
  title: '知识图 · 追问长出关系',
  stages: [
    { caption: '词条攒了一些，但关系还是稀的——孤立的词条算不上知识', ms: 3000 },
    { caption: '对词条点「向 AI 追问」：开一条独立会话，自动带上原对话摘要', ms: 3600 },
    { caption: '追问回复里抽出的词条自动连回来——一次追问长出一个星型', ms: 4200 },
    { caption: '孩子还能再追问：星就长成了树', ms: 3800 },
    { caption: 'AI 连的边都标着「未经确认」——确认一次就转成实线', ms: 4400 },
  ],
  View: GraphDemo,
};

/**
 * 对战演示：对阵 → 对手正在出题 → 轮到你答 → 判定 → 结算。
 *
 * ★ 三个演示的排序口径：**词条是机制，知识图是产物，对战是应用**——先看词从哪来，
 *   再看词怎么连起来，最后看它怎么被拿去练。
 * ★ 五帧里每一帧都指得回一个真实屏态（组件与行号在 `PkFlowDemo.tsx` 头注里）。
 *   动效只有产品 `pk.css` 那 6 条 keyframes，**没有任何一个装饰元素**：老板 2026-09-21
 *   的口径是「实际效果和演示效果差别不要太大，别货不对板」，而 09-16 那份过渡动效探索稿
 *   里的大半签名动效产品从来没实现过——所以这一批的产出主要是**删**。
 * ★ 帧时长按帧内计时器反算过：出题中「已过 Ns」走完 8 格要 3.04s（< 3200ms），
 *   答题 45s 递减走完要 4.05s（< 4400ms）——帧被切走时数字都刚好走到头。
 */
export const PK_FLOW: DemoDefinition = {
  key: 'pk-flow',
  title: '对战 · PK',
  stages: [
    { caption: '对阵：你与对手各占一栏，中间是本轮主题', ms: 2000 },
    { caption: '对手正在出题：只给呼吸和「已过 Ns」，不给假进度条', ms: 3200 },
    { caption: '轮到你答：45 秒真倒计时，最后 10 秒变粗提醒', ms: 4400 },
    { caption: '判定：答对只闪一条横幅，2.5 秒后自动清空', ms: 2600 },
    { caption: '结算：胜败、原因与终局比分，逐条登场', ms: 3200 },
  ],
  View: PkFlowDemo,
};

/**
 * 演示注册表。★ 2026-09-20 知识图批：老板预告的第二个演示已按当时的预留落地——
 *   `LandingDemo.tsx` 与播放器**一行未改**（它早就在按数组渲染，且 `length > 1` 时
 *   自动画出切换 Tab）。这正是当初把「帧序列」与「帧渲染器」拆成两件事的回报。
 * ★ 2026-09-21 对战批**再次兑现**同一句预留：追加 `PK_FLOW` 时外壳与播放器仍是一行未改。
 *
 * 顺序 = 落地页里的展示顺序。
 */
export const LANDING_DEMOS: DemoDefinition[] = [TERM_FLOW, GRAPH_FLOW, PK_FLOW];

/** 注册表为空的兜底（理论不可达）——用来避开 hook 前的条件返回与 `!` 断言 */
export const EMPTY_DEMO: DemoDefinition = {
  key: 'empty',
  title: '',
  stages: [{ caption: '', ms: 4000 }],
  View: () => null,
};
