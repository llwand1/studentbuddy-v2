/**
 * flow-templates —— 学习流的**参考模板**（新建一条流时的起点）。契约 docs/STUDY-FLOW-SPEC.md §2.3。
 *
 * ★ 为什么必须要有这个文件（2026-09-17 老板实测反馈）：
 *   原来点「新建」给的是**一个空步骤**——`explain` 的 `topic` 是 `required` 且没有默认值，
 *   于是用户一进去就看到一个空着的「必填」，点保存或开跑直接被拒
 *   「步骤「讲解」缺少必填参数：讲解主题（topic）」。
 *   这不是参数校验的 bug，而是**起点给错了**：面对一条空白流，用户无从知道
 *   "一条学习流长什么样、步骤该怎么连、参数该填什么形式"。校验是对的，缺的是**参考**。
 *
 * ★ 参考的成熟做法（两家都核过文档/源码，不是凭印象）：
 *   · **Dify**：新建应用的第一步就是**选模板**（「从空白创建」只是选项之一），
 *     模板里节点与参数都已配好，进编辑器即可直接跑或改；
 *   · **n8n**：lint 规则 `node-param-default-missing` 强制**每个参数必须有 `default`**
 *     （`required` 只约束执行期、不阻断配置），另有 workflow template 库供一键导入。
 *   两家共同的取舍：**先给一份能跑、可照抄的东西，再让用户改**，而不是先给空白再报错。
 *
 * ★ 本文件的硬纪律：**每个模板的每一步都必须能过 `validateStepParams`**
 *   （`flow-templates.test.ts` 逐模板逐步骤钉住，用的是与服务端执行期同一份代码）。
 *   于是「用模板新建出来的流开箱就能跑」不是口头承诺，而是机器可验的事实。
 *
 * ★ 为什么**不提供"空白模板"**：服务端在**保存**时就会跑同一份校验
 *   （`learning/study-flow.ts` 的 `validateDefInput` → `validateStepParams`），
 *   一个缺必填的空白起点会被当场 400 拒掉——用户点完「新建」立刻吃一句「缺少必填参数」，
 *   正是 2026-09-17 老板实测到的那一幕。要自定义就从现有模板上删步骤/改参数，
 *   **起点必须是存得下、跑得动的**。
 *
 * ★ 参数里的主题是**示例值**（如「函数的单调性」）——照 n8n 的 `default` 思路：可跑优先，
 *   用户改成自己要学的主题即可。模板的 `why` 写清编排意图，让用户看懂"为什么这么连"，
 *   而不是只看到一堆框。
 */
import type { FlowDefInput, FlowPort, FlowStepKind } from '@sb/shared';
import { STEP_BOX, snapGrid, type Point } from './flow-layout';

/** 模板内的一步。`id` 是**模板内局部 id**，只用于模板内部连线引用，落库时换成真 id */
export interface FlowTemplateStep {
  id: string;
  kind: FlowStepKind;
  /** 留空则回落注册表默认名（用户可改） */
  label?: string;
  params: Record<string, unknown>;
  /** 画布第几排（0 = 主线，1 = 下方）。分支目标的步骤下沉一排，线才不打架 */
  row?: number;
}

/** 模板内的一条连线。用局部 id 而不是索引——索引要人肉数，改一处顺序就连错 */
export interface FlowTemplateEdge {
  from: string;
  port: FlowPort;
  to: string;
}

export interface FlowTemplate {
  key: string;
  /** 新建出来的流默认就叫这个名字（用户可改） */
  name: string;
  /** 一句话：这条流是干什么的 */
  summary: string;
  /** 为什么这么编排（三出口/分支的用意）——用户在选定前能看懂 */
  why: string;
  recommended?: boolean;
  steps: FlowTemplateStep[];
  edges: FlowTemplateEdge[];
}

/** 栅格：横向一列 232px（卡片 152 + 间隙 80），纵向一排 152px（卡片 68 + 间隙 84） */
const COL_PITCH = STEP_BOX.w + 80;
const ROW_PITCH = STEP_BOX.h + 84;
const ORIGIN = { x: 140, y: 160 } as const;

/**
 * 模板里第 (col, row) 个步骤的中心坐标。
 * ★ 不复制服务端那套 `80 + i*200` 等距铺位（那是"用户没拖过"时的兜底），也**不调** `nextFreeCenter`
 *   （那是"在已有链尾追加"的规则）——模板是**一次性摆好整排**，需要的是栅格，不是追加。
 */
export function templatePosition(col: number, row = 0): Point {
  return {
    x: snapGrid(ORIGIN.x + col * COL_PITCH),
    y: snapGrid(ORIGIN.y + row * ROW_PITCH),
  };
}

/**
 * 模板清单。
 *
 * ★ 为什么「四步课堂」是推荐的：它是唯一**用上了分支**的模板——判分那步的「答错」出口
 *   连到错题复盘。这正是"学习流 ≠ 顺序执行脚本"的地方，值得让用户第一眼就看到。
 */
export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    key: 'lesson',
    name: '四步课堂',
    recommended: true,
    summary: '讲解 → 出题 → 判分；答错自动去复盘，最后沉淀成词条',
    why: '把一次完整学习固定下来。判分那步的「答错」出口单独连到复盘——这就是学习流和"按顺序跑一遍"的区别：同一步的下一步，可以因结果不同而不同。',
    steps: [
      {
        id: 'explain',
        kind: 'explain',
        params: { topic: '函数的单调性', depth: 'normal', withExample: true },
      },
      {
        id: 'quiz',
        kind: 'quiz',
        params: { topic: '函数的单调性', count: 3, online: true },
      },
      { id: 'grade', kind: 'grade', params: { strict: false } },
      {
        id: 'review',
        kind: 'review',
        params: { scope: 'weak', max: 5 },
        row: 1,
      },
      {
        id: 'digest',
        kind: 'digest',
        params: { domain: 'general', minImportance: 0.4 },
      },
    ],
    edges: [
      { from: 'explain', port: 'next', to: 'quiz' },
      { from: 'quiz', port: 'next', to: 'grade' },
      { from: 'grade', port: 'correct', to: 'digest' },
      { from: 'grade', port: 'wrong', to: 'review' },
      { from: 'review', port: 'next', to: 'digest' },
    ],
  },
  {
    key: 'drill',
    name: '错题重练',
    summary: '直接出题 → 判分；错的去复盘，答对就沉淀收工',
    why: '不讲课，直接测。适合已经学过一遍、要查漏的时候：答对直接沉淀词条结束，答错才进复盘——把时间花在没掌握的地方。',
    steps: [
      { id: 'quiz', kind: 'quiz', params: { topic: '函数的单调性', count: 5, online: true } },
      { id: 'grade', kind: 'grade', params: { strict: false } },
      { id: 'review', kind: 'review', params: { scope: 'weak', max: 10 } },
      { id: 'digest', kind: 'digest', params: { domain: 'general', minImportance: 0.4 } },
    ],
    edges: [
      { from: 'quiz', port: 'next', to: 'grade' },
      { from: 'grade', port: 'correct', to: 'digest' },
      { from: 'grade', port: 'wrong', to: 'review' },
      { from: 'review', port: 'next', to: 'digest' },
    ],
  },
  {
    key: 'cram',
    name: '考前速通',
    summary: '深讲 → 多出几题 → 出一份总结，不沉淀词条',
    why: '考前不建长期词条库，只要"讲透 + 练够 + 留一份可回顾的总结"。所以结尾是总结而不是沉淀，讲解也调成了深讲。',
    steps: [
      {
        id: 'explain',
        kind: 'explain',
        params: { topic: '函数的单调性', depth: 'deep', withExample: false },
      },
      { id: 'quiz', kind: 'quiz', params: { topic: '函数的单调性', count: 5, online: true } },
      { id: 'summary', kind: 'summary', params: { style: 'outline' } },
    ],
    edges: [
      { from: 'explain', port: 'next', to: 'quiz' },
      { from: 'quiz', port: 'next', to: 'summary' },
    ],
  },
];

/** 按 key 取模板（未知 key 返回 undefined，调用方负责报错——不静默兜底） */
export function findTemplate(key: string): FlowTemplate | undefined {
  return FLOW_TEMPLATES.find((t) => t.key === key);
}

/** 取健壮的局部 id → 落库 id 映射（缺项**抛错**，不静默给个空 id 让服务端 400） */
function requireId(idOf: Map<string, string>, key: string, tplKey: string): string {
  const v = idOf.get(key);
  if (!v) throw new Error(`模板「${tplKey}」的连线引用了一个不存在的步骤：「${key}」`);
  return v;
}

/**
 * 模板 → 提交形状（`FlowDefInput`）。
 *
 * ★ `newId` 由调用方注入（`flow-actions.newStepId`）：`crypto.randomUUID` 只在 secure context 可用，
 *   本地开 http 时可能没有——兜底逻辑留在那一处，不在模板里再抄一遍。
 * ★ `params` 逐个浅拷一份：模板常量是模块级共享的，直接引用会让「改一条新建出来的流」
 *   有机会改到模板本体（下一轮新建就带着上次的改动，且极难查）。
 */
export function buildTemplateDef(tpl: FlowTemplate, newId: () => string): FlowDefInput {
  const idOf = new Map<string, string>();
  for (const s of tpl.steps) idOf.set(s.id, newId());
  const steps = tpl.steps.map((s, col) => ({
    id: idOf.get(s.id),
    kind: s.kind,
    label: s.label ?? '',
    params: { ...s.params },
    position: templatePosition(col, s.row ?? 0),
    orderIndex: col,
  }));
  const edges = tpl.edges.map((e) => ({
    fromStepId: requireId(idOf, e.from, tpl.key),
    toStepId: requireId(idOf, e.to, tpl.key),
    fromPort: e.port,
  }));
  return { name: tpl.name, description: tpl.summary, steps, edges };
}
