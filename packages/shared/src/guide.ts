/** guide: split domain module; compatible exports remain at guide.ts. */
import type { GuideFacts } from './guide-models.js';
import type { GuideStage } from './guide-models.js';
import type { GuideKind } from './guide-models.js';
import type { GuideLang } from './guide-models.js';
import { GUIDE_TOPICS } from './guide-catalog.js';
import { GUIDE_CATALOG } from './guide-catalog.js';
import type { GuideText } from './guide-models.js';
import { GUIDE_TEXT_KINDS } from './guide-models.js';
import type { GuideItem } from './guide-models.js';
import { GUIDE_HEADLINES } from './guide-catalog.js';
import type { GuideResult } from './guide-models.js';
import { GUIDE_MAX_ITEMS } from './guide-models.js';
import { GUIDE_TEXT_MAX } from './guide-models.js';
import { GUIDE_TEXT_MIN } from './guide-models.js';
import { GUIDE_LIMITS } from './guide-models.js';
import { isGuideKind } from './guide-models.js';
import { GUIDE_TEXT_KIND_QUOTA } from './guide-models.js';
import { GUIDE_LABEL_MIN } from './guide-models.js';
import type { GuideNextRequest } from './guide-models.js';
import { GUIDE_VIEWS } from './guide-models.js';
import { GUIDE_CAN_MAX } from './guide-models.js';
import type { GuideView } from './guide-models.js';

/**
 * 阶段判定：自上而下第一条命中的为准（契约 §5）。
 * `quizzed` 看的是 `can`——「一键解析 / 再练一遍」只有在题卡真的答完时才会被 QuizReview 注册，
 * 所以这里不需要（也不应该）自己再去数「答了几题」。
 */
export function guideStage(f: GuideFacts): GuideStage {
  if (!f.hasModel) return 'nomodel';
  if (f.view !== 'chat') return 'tour';
  if (f.busy) return 'busy';
  if (f.can.includes('quiz.explain') || f.can.includes('quiz.retry')) return 'quizzed';
  if (!f.chat || f.chat.rounds === 0) return 'fresh';
  return 'chatted';
}

/** 各阶段可选动作（按默认优先级）。最终还要与 `can` 取交集、去掉「当前页」自己 */
const STAGE_KINDS: Record<GuideStage, readonly GuideKind[]> = {
  nomodel: ['nav.settings', 'nav.terms', 'nav.continent'],
  tour: ['chat.topic', 'session.new', 'nav.continent', 'nav.terms', 'nav.pk', 'nav.settings'],
  busy: [],
  quizzed: ['quiz.explain', 'quiz.retry', 'chat.remember', 'chat.topic', 'session.new', 'nav.continent'],
  fresh: ['chat.topic', 'nav.continent', 'nav.terms', 'nav.pk', 'nav.settings'],
  chatted: ['quiz.start', 'quiz.scenario', 'chat.ask', 'chat.remember', 'chat.videos', 'session.new', 'nav.continent', 'nav.terms'],
};

export function eligibleKinds(f: GuideFacts, stage: GuideStage = guideStage(f)): GuideKind[] {
  const can = new Set<string>(f.can);
  return STAGE_KINDS[stage].filter((k) => can.has(k) && k !== `nav.${f.view}`);
}

/**
 * 必备项（契约 §2）：每组「任一」即满足；组内没有一个可选的就整组不要求。
 * 这是用户点名的三个时刻——第一次＝随机话题、聊完＝出题、做完题＝一键解析。
 */
const MUST: Partial<Record<GuideStage, readonly (readonly GuideKind[])[]>> = {
  fresh: [['chat.topic']],
  chatted: [['quiz.start', 'quiz.scenario']],
  quizzed: [['quiz.explain']],
};

function requiredGroups(stage: GuideStage, eligible: readonly GuideKind[]): GuideKind[][] {
  return (MUST[stage] ?? []).map((g) => g.filter((k) => eligible.includes(k))).filter((g) => g.length > 0);
}

// ── 文本小工具 ─────────────────────────────────────────────────────────────
/** 去控制字符与换行、压空白、按**字符**（不拆代理对）截断 */
export function cleanGuideLine(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- 这里就是要剔除控制字符
  const flat = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? chars.slice(0, max).join('') : flat;
}

/** 预览用短串：超长加省略号 */
export function shortGuideText(v: string, max: number): string {
  const flat = cleanGuideLine(v, 10_000);
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

const topicAt = (seed: number, lang: GuideLang): string => {
  const n = GUIDE_TOPICS.length;
  const i = ((Math.trunc(seed) % n) + n) % n;
  return GUIDE_TOPICS[i]?.[lang] ?? GUIDE_TOPICS[0]?.[lang] ?? '';
};

/** 文本动作的兜底文本 */
export function defaultGuideText(kind: GuideKind, lang: GuideLang, seed = 0): string | undefined {
  if (kind === 'chat.topic') return topicAt(seed, lang);
  return GUIDE_CATALOG[kind].text?.[lang];
}

/** 番茄钟进行中（契约 POMODORO-SPEC §5）：随机话题换成方向里的开场白——「方向」比「有趣」优先 */
const FOCUS_TOPICS: readonly ((subject: string) => GuideText)[] = [
  (x) => ({ zh: `「${x}」里最容易混淆的两个概念是什么？帮我分清楚。`, en: `What are the two most confusable ideas in "${x}"? Help me tell them apart.` }),
  (x) => ({ zh: `用一个生活里的例子讲清「${x}」的一个核心概念。`, en: `Explain one core idea of "${x}" with an everyday example.` }),
  (x) => ({ zh: `「${x}」考试里最常考的点是什么？从最基础的讲起。`, en: `What gets tested most in "${x}"? Start from the basics.` }),
];

/** 带方向的兜底文本：`chat.topic` / `chat.ask` 都围绕方向；没方向退 `defaultGuideText` */
export function focusGuideText(kind: GuideKind, f: Pick<GuideFacts, 'lang' | 'focus'>, seed = 0): string | undefined {
  const subject = f.focus?.subject;
  if (!subject || !GUIDE_TEXT_KINDS.includes(kind)) return defaultGuideText(kind, f.lang, seed);
  if (kind === 'chat.ask') {
    return f.lang === 'zh' ? `刚才这段和「${subject}」有什么关系？帮我接回主线。` : `How does this connect back to "${subject}"? Tie it to the main thread.`;
  }
  const n = FOCUS_TOPICS.length;
  const i = ((Math.trunc(seed) % n) + n) % n;
  return (FOCUS_TOPICS[i] ?? FOCUS_TOPICS[0]!)(subject)[f.lang];
}

/** 带现场数据的副行（规则推荐用）；没有可写的数据就返回 null，由目录默认文案顶上 */
function dynamicHint(kind: GuideKind, f: GuideFacts, text?: string): string | null {
  const zh = f.lang === 'zh';
  switch (kind) {
    case 'chat.topic':
      return text ? (zh ? `开聊：「${shortGuideText(text, 22)}」` : `Start with: "${shortGuideText(text, 34)}"`) : null;
    case 'chat.ask':
      return text ? (zh ? `会问：「${shortGuideText(text, 22)}」` : `Will ask: "${shortGuideText(text, 34)}"`) : null;
    case 'nav.continent':
      if (f.terms.due <= 0) return null;
      return zh
        ? `有 ${f.terms.due} 条词条到期${f.terms.overdue > 0 ? `（${f.terms.overdue} 条已逾期）` : ''}，变成了怪物，去收复`
        : `${f.terms.due} term${f.terms.due > 1 ? 's are' : ' is'} due${f.terms.overdue > 0 ? ` (${f.terms.overdue} overdue)` : ''} — go win them back`;
    case 'nav.terms':
      if (f.terms.total <= 0) return null;
      return zh ? `库里已有 ${f.terms.total} 条，点进去翻翻、搜搜` : `${f.terms.total} saved — browse and search them`;
    case 'quiz.start': {
      if (f.focus) return zh ? `围绕「${f.focus.subject}」出题，当场判分` : `Questions on "${f.focus.subject}", graded on the spot`;
      const t = f.chat?.lastUser ? shortGuideText(f.chat.lastUser, 14) : '';
      if (!t) return null;
      return zh ? `基于「${t}」出题，当场判分` : `Questions on "${t}", graded on the spot`;
    }
    default:
      return null;
  }
}

function defaultItem(kind: GuideKind, f: GuideFacts, seed: number): GuideItem {
  const info = GUIDE_CATALOG[kind];
  const text = GUIDE_TEXT_KINDS.includes(kind) ? focusGuideText(kind, f, seed) : undefined;
  const item: GuideItem = {
    kind,
    label: info.label[f.lang],
    hint: dynamicHint(kind, f, text) ?? info.hint[f.lang],
  };
  if (text) item.text = text;
  return item;
}

function headlineOf(stage: GuideStage, f: GuideFacts): string {
  if (stage === 'nomodel' && f.view === 'settings') return GUIDE_HEADLINES.nomodelHere[f.lang];
  return GUIDE_HEADLINES[stage][f.lang];
}

/** 有欠账时把「去知识大陆」提前一位（话题是必备项，保持第一） */
function ranked(kinds: GuideKind[], f: GuideFacts, stage: GuideStage): GuideKind[] {
  if (f.terms.due <= 0 || (stage !== 'fresh' && stage !== 'tour') || !kinds.includes('nav.continent')) return kinds;
  const rest = kinds.filter((k) => k !== 'nav.continent');
  const at = rest[0] === 'chat.topic' ? 1 : 0;
  return [...rest.slice(0, at), 'nav.continent', ...rest.slice(at)];
}

/**
 * 规则推荐：没绑模型 / 模型失手 / 客户端等 AI 的那几百毫秒里用。
 * 它不是降级的残次品，而是一个诚实的默认值——界面标「常用建议」，不冒充 AI。
 */
export function ruleGuide(f: GuideFacts, seed = 0): GuideResult {
  const stage = guideStage(f);
  const kinds = ranked(eligibleKinds(f, stage), f, stage).slice(0, GUIDE_MAX_ITEMS);
  return { stage, headline: headlineOf(stage, f), items: kinds.map((k) => defaultItem(k, f, seed)) };
}

// ── 模型输出校验 ───────────────────────────────────────────────────────────
function pickText(kind: GuideKind, raw: unknown, f: GuideFacts, seed: number): string | undefined {
  if (!GUIDE_TEXT_KINDS.includes(kind)) return undefined;
  const t = cleanGuideLine(raw, GUIDE_TEXT_MAX);
  return Array.from(t).length >= GUIDE_TEXT_MIN ? t : focusGuideText(kind, f, seed);
}

/**
 * 模型输出 → 可上屏的推荐。形状不对、一条合格的都没有 ⇒ null（交给网关的「修复一次」，再不行走规则推荐）。
 * 逐条：kind 必须在**此刻可选**集合里；同 kind 去重（带文本的各最多 2 条）；label / hint 不合格就换默认文案
 * （不因为文案差而丢掉一个好动作）；带文本的动作 text 不合格就换兜底文本；最后补齐必备项。
 */
export function normalizeGuideReply(raw: unknown, f: GuideFacts, seed = 0): GuideResult | null {
  const stage = guideStage(f);
  const eligible = eligibleKinds(f, stage);
  if (eligible.length === 0) return null;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { headline?: unknown; items?: unknown };
  if (!Array.isArray(o.items)) return null;

  const limits = GUIDE_LIMITS[f.lang];
  const items: GuideItem[] = [];
  const seen = new Map<GuideKind, number>();
  for (const entry of o.items) {
    if (items.length >= GUIDE_MAX_ITEMS) break;
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { kind?: unknown; label?: unknown; hint?: unknown; text?: unknown };
    if (!isGuideKind(e.kind) || !eligible.includes(e.kind)) continue;
    const kind = e.kind;
    const quota = GUIDE_TEXT_KINDS.includes(kind) ? GUIDE_TEXT_KIND_QUOTA : 1;
    if ((seen.get(kind) ?? 0) >= quota) continue;
    const info = GUIDE_CATALOG[kind];
    const text = pickText(kind, e.text, f, seed + items.length);
    const label = cleanGuideLine(e.label, limits.label);
    const hint = cleanGuideLine(e.hint, limits.hint);
    const item: GuideItem = {
      kind,
      label: Array.from(label).length >= GUIDE_LABEL_MIN ? label : info.label[f.lang],
      hint: hint || dynamicHint(kind, f, text) || info.hint[f.lang],
    };
    if (text) item.text = text;
    // 同种带文本动作不许发出同一句话两次
    if (text && items.some((x) => x.kind === kind && x.text === text)) continue;
    items.push(item);
    seen.set(kind, (seen.get(kind) ?? 0) + 1);
  }
  if (items.length === 0) return null;

  // 必备项：缺就插到第一位（若已满 4 条，顶掉末尾一条——必备项比第 4 个推荐重要）
  for (const group of requiredGroups(stage, eligible).reverse()) {
    if (items.some((it) => group.includes(it.kind))) continue;
    const first = group[0];
    if (!first) continue;
    if (items.length >= GUIDE_MAX_ITEMS) items.pop();
    items.unshift(defaultItem(first, f, seed));
  }

  const headline = cleanGuideLine(o.headline, limits.headline) || headlineOf(stage, f);
  return { stage, headline, items };
}

// ── 请求解析 ───────────────────────────────────────────────────────────────
/** 请求体 → 形状合法的请求；不合法返回 null（路由据此回 400）。未知字段忽略 */
export function parseGuideRequest(body: unknown): GuideNextRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { lang?: unknown; view?: unknown; sessionId?: unknown; can?: unknown; busy?: unknown };
  const lang = b.lang === undefined ? 'zh' : b.lang;
  if (lang !== 'zh' && lang !== 'en') return null;
  if (typeof b.view !== 'string' || !(GUIDE_VIEWS as readonly string[]).includes(b.view)) return null;
  if (!Array.isArray(b.can) || b.can.length > GUIDE_CAN_MAX) return null;
  const can: GuideKind[] = [];
  for (const k of b.can) {
    if (!isGuideKind(k)) return null;
    if (!can.includes(k)) can.push(k);
  }
  const sessionId = typeof b.sessionId === 'string' && b.sessionId.length > 0 && b.sessionId.length <= 80 ? b.sessionId : null;
  return { lang, view: b.view as GuideView, sessionId, can, busy: b.busy === true };
}

export type { GuideLang } from './guide-models.js';
export type { GuideText } from './guide-models.js';
export { GUIDE_VIEWS } from './guide-models.js';
export type { GuideView } from './guide-models.js';
export { GUIDE_KINDS } from './guide-models.js';
export type { GuideKind } from './guide-models.js';
export { isGuideKind } from './guide-models.js';
export { GUIDE_TEXT_KINDS } from './guide-models.js';
export type { GuideStage } from './guide-models.js';
export { GUIDE_MAX_ITEMS } from './guide-models.js';
export { GUIDE_LABEL_MIN } from './guide-models.js';
export { GUIDE_LIMITS } from './guide-models.js';
export { GUIDE_TEXT_MIN } from './guide-models.js';
export { GUIDE_TEXT_MAX } from './guide-models.js';
export { GUIDE_CAN_MAX } from './guide-models.js';
export { GUIDE_TEXT_KIND_QUOTA } from './guide-models.js';
export type { GuideGroup } from './guide-models.js';
export { GUIDE_GROUPS } from './guide-models.js';
export type { GuideChatFacts } from './guide-models.js';
export type { GuideFacts } from './guide-models.js';
export type { GuideItem } from './guide-models.js';
export type { GuideResult } from './guide-models.js';
export type { GuideMode } from './guide-models.js';
export type { GuideReason } from './guide-models.js';
export type { GuideNextRequest } from './guide-models.js';
export type { GuideNextResponse } from './guide-models.js';
export type { GuideKindInfo } from './guide-catalog.js';
export { GUIDE_CATALOG } from './guide-catalog.js';
export { GUIDE_HEADLINES } from './guide-catalog.js';
export { GUIDE_TEASERS } from './guide-catalog.js';
export { guideTeaser } from './guide-catalog.js';
export { GUIDE_TOPICS } from './guide-catalog.js';
