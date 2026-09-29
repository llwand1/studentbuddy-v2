/**
 * learning/quiz-photo — 出题后给题目配**网络真实图片**（照片、标准示意图、地图、文物、名画）。
 *
 * 两步：① 规划（一次轻量调用）：从已出好的题里挑最多 `MAX_PHOTOS` 道「配张真实图片会更好」的，给检索词与主题；
 *       ② 找图（`media/find-image.ts`，并行）：必须经过看图核验（`requireVerified`），且检查**不泄露答案**。
 *
 * ★ 为什么不让出题模型顺手写检索词：要改出题协议与四级解析救援（`QUIZ_PROTOCOL` / `parseQuizBlock`），
 *   而那套协议是配图 0 产率事故之后才调稳的。独立一步多花几秒，换来零耦合、可单独关掉。
 * ★ 题目必须**不看图也能答**：图是附加展示（与 `svg` 同一条纪律，判分不读它），所以盲解验算照旧有效。
 *   规划提示词明确要求这一点；泄露检查兜底「图上印着答案」。
 * ★ 任何一步失败都只是「这题没配图」，绝不让出题失败。
 */
import type { QuizPayload, QuizQuestion } from '@sb/shared';
import { aiJson } from '../ai/gateway.js';
import { routeRole } from '../llm/router.js';
import { creditLine, findImages, type FoundImage } from '../media/find-image.js';

export const MAX_PHOTOS = 2;
/** 找图总预算：真机实测规划+找图≈29s，出题本身已要几十秒，超时的题就不配图（不拖慢出题） */
export const PHOTO_BUDGET_MS = 20_000;

export interface PhotoPlanItem {
  index: number;
  query: string;
  subject: string;
}

const PLAN_SYSTEM = `你在给一组练习题挑配图。只挑「配一张**真实存在**的图片（照片、标准示意图、地图、文物、名画、标本）会让学生更好理解」的题，最多 ${MAX_PHOTOS} 道；
不挑：纯计算、纯概念辨析、需要手绘几何/受力/电路图的题（那些另有示意图）、以及一看图就能直接认出答案的题（例如「图中是什么」）。
给每道被挑中的题写：index（题号，从 0 开始）、query（图片检索词，具体名词，英文优先，如 "Terracotta Army"）、subject（中文，这张图应当展示什么）。
一道都不适合就返回空数组。只输出 JSON：{"photos":[{"index":0,"query":"…","subject":"…"}]}`;

export function parsePhotoPlan(raw: string, n: number): PhotoPlanItem[] | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { photos?: unknown };
    if (!Array.isArray(o.photos)) return null;
    const seen = new Set<number>();
    const out: PhotoPlanItem[] = [];
    for (const p of o.photos as Array<Record<string, unknown>>) {
      const index = Number(p?.index);
      const query = typeof p?.query === 'string' ? p.query.trim().slice(0, 120) : '';
      const subject = typeof p?.subject === 'string' ? p.subject.trim().slice(0, 120) : '';
      if (!Number.isInteger(index) || index < 0 || index >= n || !query || seen.has(index)) continue;
      seen.add(index);
      out.push({ index, query, subject: subject || query });
      if (out.length >= MAX_PHOTOS) break;
    }
    return out;
  } catch {
    return null;
  }
}

/** 这道题「答案」的文字形态（泄露检查用）：选择题取正确选项文字，填空取各空答案 */
export function answerTexts(q: QuizQuestion): string[] {
  const a = q.answer;
  if ((q.type === 'single' || q.type === 'multiple') && Array.isArray(a) && q.options) {
    return (a as unknown[]).flatMap((i) => (typeof i === 'number' && q.options?.[i] ? [q.options[i]] : []));
  }
  if (q.type === 'fill' && Array.isArray(a)) return (a as unknown[]).filter((x): x is string => typeof x === 'string');
  if (q.type === 'essay' && typeof a === 'string') return [a.slice(0, 60)];
  return [];
}

export const plainCredit = (img: FoundImage) => creditLine(img).replace(/^\*|\*$/g, '').replace(/ · \[出处\]\([^)]*\)/, '');

export async function attachQuizPhotos(payload: QuizPayload, ownerId: string | null, deps: { find?: typeof findImages } = {}): Promise<number> {
  // 没有视觉模型就不做：出题配图要求看过图（题上的错图比没图更糟），省掉一次白花的规划调用
  if (!routeRole('vision', undefined, ownerId)?.model) return 0;
  const qs = payload.questions;
  // 已有图的题（自包含闸门搬来的 essential 原图）不再规划：一道题一张图
  if (qs.length === 0 || qs.every((q) => q.photo)) return 0;
  const list = qs.map((q, i) => (q.photo ? `${i}. （已有配图，不要选）` : `${i}. [${q.type}] ${q.question}${q.options ? `（选项：${q.options.join(' / ')}）` : ''}`)).join('\n');
  const plan = await aiJson({
    purpose: 'quiz.photo_plan',
    ownerId,
    messages: [{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: list }],
    parse: (t) => parsePhotoPlan(t, qs.length),
    temperature: 0,
    maxTokens: 400,
  });
  if (!plan.ok || plan.value.length === 0) return 0;
  const find = deps.find ?? findImages;
  const signal = AbortSignal.timeout(PHOTO_BUDGET_MS);
  const results = await Promise.all(
    plan.value.map(async (p) => {
      const q = qs[p.index];
      if (!q || q.photo) return null;
      const r = await find({ query: p.query, subject: p.subject, ownerId, requireVerified: true, signal, quiz: { question: q.question, answers: answerTexts(q) } }).catch(() => null);
      const img = r?.images[0];
      return img ? { index: p.index, img } : null;
    }),
  );
  let n = 0;
  for (const r of results) {
    const q = r ? qs[r.index] : undefined;
    if (!r || !q) continue;
    q.photo = { src: r.img.src, alt: r.img.alt, credit: plainCredit(r.img), ...(r.img.pageUrl ? { pageUrl: r.img.pageUrl } : {}) };
    n += 1;
  }
  return n;
}
