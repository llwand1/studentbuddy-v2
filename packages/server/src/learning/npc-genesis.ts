/**
 * learning/npc-genesis — 创建伙伴时的**起名与人设**，以及"伙伴用哪个模型"（契约 `docs/NPC-PARTNER-SPEC.md` §4）。
 *
 * ★ 与 `npc-talk.ts` 同一条降级纪律：**永不报错、永不空回**。AI 不可用（未绑角色／无 key／上游抖动／
 *   返回的不是 JSON）⇒ 走本地池子（`npcNameFromPool` + `npcTemplateBio`），并在结果里标
 *   `source: 'fallback'` —— 创建面板据此如实说一句"名字是本地起的，绑了模型他会自己取"。
 *   **降级可以，假装没降级不行**（ADR-5 的"报错说真话"在这里的等价物是"降级说真话"）。
 *
 * ★ 人设只许说他守的那条词条与领域，**不许编造用户进度**（同 `NPC_FALLBACK_LINES` 的判断标准）：
 *   编了就会与卡墙／任务清单的数字打架。
 *
 * ★ `resolveNpcTarget` 住在本文件而不是 `npc-talk.ts`：它是"伙伴这一族用哪个模型角色"的唯一口径，
 *   对话（talk）与起名（genesis）都要读它。放在这里还有一个好处——**不出环**：
 *   `npc-talk.ts` 需要 `NpcView`（来自 `npc.ts`），若 target 也住在那边，`npc-genesis → npc-talk → npc.ts`
 *   就会与 `npc.ts → npc-party → npc-genesis` 撞成一个环。
 */
import {
  NPC_BIO_MAX,
  normalizeNpcBio,
  normalizeNpcName,
  npcNameFromPool,
  npcTemplateBio,
  NPC_JOB_LABEL,
  NPC_JOB_STYLE,
  NPC_MOOD_LABEL,
  NPC_MOOD_STYLE,
  type NpcJob,
  type NpcMood,
} from '@sb/shared';
import { routeRole } from '../llm/router.js';
import type { ChatMessage } from '../llm/types.js';

/** 起名输出的上限（一个 JSON 对象而已；给足余量，免得模型写到一半被截断） */
const NPC_GEN_MAX_TOKENS = 300;
/** 温度比对话再高一点：起名要的是"有点意思"，不是"稳" */
const NPC_GEN_TEMPERATURE = 0.9;

/** 起名结果。★ `fallback` 不是"失败了"，是"现在只能这样"——UI 必须据此说实话 */
export interface NpcIdentity {
  name: string;
  bio: string;
  source: 'ai' | 'fallback';
}

/** 与 `resolveCoachTarget` 同形：`npc` 未绑定 ⇒ 回退讲解（伙伴这一族本质是日常对话，§4.1） */
export function resolveNpcTarget(ownerId: string | null) {
  const own = routeRole('npc', undefined, ownerId);
  if (own?.model) return own;
  return routeRole('explain', undefined, ownerId) ?? own;
}

function buildGenesisPrompt(term: string, domain: string, job?: NpcJob, mood?: NpcMood): string {
  return [
    `你在给知识大陆上的一位新学习伙伴写"身份卡"。他守的词条是「${term}」，领域是「${domain}」。`,
    job ? `他的职业是${NPC_JOB_LABEL[job]}（古典剑与魔法世界）。${NPC_JOB_STYLE[job]}` : '',
    mood ? `他的性格是「${NPC_MOOD_LABEL[mood]}」。${NPC_MOOD_STYLE[mood]}` : '',
    '严格只回一个 JSON 对象，不要代码块、不要解释、不要多余的字：',
    '{"name":"名字","bio":"一句自我介绍"}',
    'name 要求：2~6 个字，像一个住在附近的人的名字或绰号；不要「助手」「AI」「小助手」这类词。',
    `bio 要求：不超过 ${NPC_BIO_MAX} 字，第一人称，一句话，带一点脾气或习惯（例：爱较真、说话慢、总忘事）。`,
    `只许谈「${term}」和「${domain}」这一块。`,
    '★ 不要编造用户的学习进度、复习数字、卡牌数量、欠账——那些由别的面板说，你说了就会和它们对不上。',
  ].filter(Boolean).join('\n');
}

/**
 * 从模型输出里抠出第一个 JSON 对象。
 * ★ 不要求"整段就是 JSON"：模型常带一句解释或代码块围栏，那种脆弱的判断标准会让降级率无谓地高；
 *   `name`/`bio` 的合法性仍由归一化那一步把关（空串 ⇒ 整份回退）。
 */
function pickJson(text: string): { name?: unknown; bio?: unknown } | null {
  const at = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (at < 0 || end <= at) return null;
  try {
    const v = JSON.parse(text.slice(at, end + 1)) as unknown;
    return v && typeof v === 'object' ? (v as { name?: unknown; bio?: unknown }) : null;
  } catch {
    return null;
  }
}

/**
 * 生成一位伙伴的名字与人设。**永不抛**（上游抖动也在内），失败时整份回退本地池子。
 */
export async function generateNpcIdentity(opts: {
  ownerId: string | null;
  termId: string;
  term: string;
  domain: string;
  job?: NpcJob;
  mood?: NpcMood;
  signal?: AbortSignal;
}): Promise<NpcIdentity> {
  const fallback = (): NpcIdentity => ({
    name: npcNameFromPool(opts.termId),
    bio: npcTemplateBio(opts.term),
    source: 'fallback',
  });
  const target = resolveNpcTarget(opts.ownerId);
  if (!target?.model || !target.apiKey) return fallback();

  const messages: ChatMessage[] = [
    { role: 'system', content: buildGenesisPrompt(opts.term, opts.domain, opts.job, opts.mood) },
    { role: 'user', content: '给他起个名字和一句自我介绍。' },
  ];
  let acc = '';
  try {
    for await (const chunk of target.adapter.chat({
      model: target.model,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      messages,
      temperature: NPC_GEN_TEMPERATURE,
      maxTokens: NPC_GEN_MAX_TOKENS,
      streamMode: 'once',
      signal: opts.signal,
    })) {
      if (chunk.content) acc += chunk.content;
      if (chunk.done) break;
    }
  } catch {
    // 上游抖动也走降级：创建伙伴不许因为一次报错变成"坏掉的功能"（同 §4.2 的判断标准）
    return fallback();
  }

  const parsed = pickJson(acc);
  const name = normalizeNpcName(typeof parsed?.name === 'string' ? parsed.name : '');
  const bio = normalizeNpcBio(typeof parsed?.bio === 'string' ? parsed.bio : '');
  // ★★ 两样都得有才算"AI 起的"：只拿回一半就整份回退。
  //   否则会出现"AI 的名字 + 模板的人设"这种半吊子，还把它标成 `source:'ai'`（降级可以，假装没降级不行）。
  if (!name || !bio) return fallback();
  return { name, bio, source: 'ai' };
}