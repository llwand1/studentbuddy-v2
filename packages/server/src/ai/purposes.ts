/**
 * ai/purposes — **AI 用途登记表**（提示词注册的一半：谁在调模型、用哪个角色、提示词第几版）。
 *
 * ★ 为什么要登记：改前全仓 14 处各自 `routeRole(...)` 后直接 `adapter.chat(...)`，
 *   超时、重试、JSON 修复、耗时与失败统计全都各写各的（或者干脆没写）。登记之后：
 *   - 网关按用途给默认角色、默认超时、上游优先级 ⇒ 调用点只写"我要干什么"；
 *   - `llm_call.purpose` 有了稳定的枚举 ⇒ 「AI 运行状况」能按用途看成功率与耗时；
 *   - `version` 跟着提示词改 ⇒ 改一次提示词就 +1，前后两版的成功率能直接对比。
 * ★ 改提示词时**必须**把对应条目的 `version` +1（`purposes.test.ts` 锁了"每条都有正整数版本"）。
 */
import type { ModelRole } from '@sb/shared';
import type { UpstreamPurpose } from '../llm/types.js';

export interface AiPurposeInfo {
  /** 给人看的名字（设置页「AI 运行状况」用） */
  label: string;
  /** 缺省模型角色（调用方可以自带 target 覆盖，例如 coach/npc 的回落链） */
  role: ModelRole;
  /** 提示词版本：改提示词就 +1 */
  version: number;
  /** 上游优先级：用户正等着 ⇒ main；为下一轮备料 ⇒ background */
  upstream: UpstreamPurpose;
  /** 单次调用超时（毫秒）。出题一次十题带 SVG 常要一分多钟，故按用途给 */
  timeoutMs: number;
}

export const AI_PURPOSES = {
  'chat.turn': { label: '对话回答', role: 'explain', version: 3, upstream: 'main', timeoutMs: 180_000 },
  'chat.compact': { label: '会话压缩与画像', role: 'summarizer', version: 1, upstream: 'background', timeoutMs: 120_000 },
  'chat.vision': { label: '看图', role: 'vision', version: 1, upstream: 'main', timeoutMs: 90_000 },
  'image.verify': { label: '配图核验', role: 'vision', version: 1, upstream: 'main', timeoutMs: 45_000 },
  'quiz.photo_plan': { label: '出题配图规划', role: 'quiz-generator', version: 1, upstream: 'main', timeoutMs: 30_000 },
  'term.extract': { label: '抽取词条', role: 'explain', version: 1, upstream: 'background', timeoutMs: 90_000 },
  'term.relate': { label: '词条关系', role: 'explain', version: 1, upstream: 'background', timeoutMs: 90_000 },
  'term.tidy': { label: '整理词条库', role: 'explain', version: 1, upstream: 'main', timeoutMs: 120_000 },
  'quiz.generate': { label: '出题', role: 'quiz-generator', version: 3, upstream: 'main', timeoutMs: 180_000 },
  'quiz.verify': { label: '盲解验题', role: 'solver', version: 1, upstream: 'main', timeoutMs: 60_000 },
  'quiz.grade': { label: '主观题评分', role: 'solver', version: 1, upstream: 'main', timeoutMs: 45_000 },
  'quiz.explain': { label: '作答讲解', role: 'solver', version: 1, upstream: 'main', timeoutMs: 120_000 },
  'scenario.generate': { label: '情景任务', role: 'quiz-generator', version: 1, upstream: 'main', timeoutMs: 180_000 },
  'collect.draft': { label: '现场搜集出题', role: 'quiz-generator', version: 1, upstream: 'main', timeoutMs: 180_000 },
  'coach.message': { label: '复习督促', role: 'coach', version: 1, upstream: 'background', timeoutMs: 60_000 },
  'npc.genesis': { label: '伙伴诞生', role: 'npc', version: 1, upstream: 'main', timeoutMs: 60_000 },
  'npc.talk': { label: '伙伴对话', role: 'npc', version: 2, upstream: 'main', timeoutMs: 60_000 },
  'npc.ping': { label: '伙伴主动搭话', role: 'npc', version: 1, upstream: 'background', timeoutMs: 45_000 },
  'continent.expand': { label: '大陆开拓出词', role: 'explain', version: 1, upstream: 'main', timeoutMs: 45_000 },
  'coach.trend': { label: '复习趋势摘要', role: 'coach', version: 1, upstream: 'background', timeoutMs: 60_000 },
  'chat.grill': { label: '收尾追问选项', role: 'explain', version: 1, upstream: 'main', timeoutMs: 60_000 },
  'pk.judge': { label: '对战裁判', role: 'judge', version: 1, upstream: 'main', timeoutMs: 60_000 },
  'pk.bot': { label: '对战 AI 选手', role: 'solver', version: 1, upstream: 'main', timeoutMs: 45_000 },
} as const satisfies Record<string, AiPurposeInfo>;

export type AiPurpose = keyof typeof AI_PURPOSES;

export function isAiPurpose(s: string): s is AiPurpose {
  return Object.prototype.hasOwnProperty.call(AI_PURPOSES, s);
}
