/**
 * PK 出题的词条素材通道（PK-SPEC §15 B3，2026-09-20）——从 match.ts 拆出的原因：
 * match.ts 已贴 400 行门禁，词条这块自成一段（校验 + 拼约束），独立文件好测好回滚。
 *
 * 老板拍板（§15.6）：**可选 + 选了即硬绑定**——不选走原路径（逐字不变），选了就把
 * 词条约束拼进出题提示词，跑题判定沿用既有 `judgeTopicFit`（判整体贴合度，零新增裁判逻辑）。
 *
 * ★ 本文件**不 import match**（match 反向 import 本文件）：不造循环依赖（judge ↔ match 的前车之鉴）。
 *   校验失败以 `error` 码返回，由 match 层用既有 `fail()` 抛。
 */
import { PK_TERM_MAX, type PkRoomError } from '@sb/shared';
import { listTermsByIds, type TermApiRow } from '../learning/terms.js';

export interface PkTermsResolved {
  terms: TermApiRow[];
  /** 非 null = 校验失败（调用方 fail(code)）。错误必须在 CD 落之前抛：选错词条是请求方的输入错误，不该吃 60 秒出题冷却 */
  error: Extract<PkRoomError, 'TERM_LIMIT_EXCEEDED' | 'TERM_NOT_FOUND'> | null;
}

/**
 * 校验并解析出题人带的词条 id：超上限 → TERM_LIMIT_EXCEEDED；取不全（不存在**或不属于
 * 提交者**，owner 隔离在 SQL WHERE 里）→ TERM_NOT_FOUND——按 §15.6 合成一个码，
 * 不向无权限者泄露「这个 id 存在」。
 */
export function resolvePkTerms(rawIds: readonly unknown[], ownerId: string | null): PkTermsResolved {
  const ids = [...new Set(rawIds.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))];
  if (ids.length > PK_TERM_MAX) return { terms: [], error: 'TERM_LIMIT_EXCEEDED' };
  const terms = listTermsByIds(ids, ownerId);
  if (terms.length !== ids.length) return { terms: [], error: 'TERM_NOT_FOUND' };
  return { terms, error: null };
}

/**
 * 词条 → 出题素材与硬约束。双通道各司其职：
 * - `constraint`（进提示词）：点名词条让模型「尽量出对」，裁判判贴合度时看得到这句；
 * - `material`（走 `generateQuiz` 第 2 参，此前恒 undefined）：释义原文喂给模型 + 联网检索，出题有据可依。
 */
export function pkTermConstraint(
  terms: readonly TermApiRow[],
): { constraint: string; material: string | undefined } {
  if (!terms.length) return { constraint: '', material: undefined };
  const list = terms.map((t) => `${t.term}（${t.definition}）`).join('；');
  return {
    constraint: `，且必须考察以下词条：${list}`,
    material: `出题词条素材（本题必须围绕这些词条）：
${terms.map((t) => `【${t.term}】${t.definition}`).join('\n')}`,
  };
}
