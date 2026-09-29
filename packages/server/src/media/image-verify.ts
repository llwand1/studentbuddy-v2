/**
 * media/image-verify — 让视觉模型**看一眼**候选图：是不是要找的东西、图里有没有会泄露答案的文字。
 *
 * ★ 为什么必须看图：搜索引擎按文件名/周边文字匹配，「线粒体」能搜出叶绿体、细胞全图、甚至一张线粒体主题的海报。
 *   只按标题挑图，错图率高得离谱（离线评测 `npm run eval -- vision` 量的就是这个）。
 * ★ 出题配图多一道「不泄露答案」：图里写着答案（带标注的示意图、文件名式水印）等于把答案印在题上。
 *   模型报出图中可读文字，服务端再**自己**做一次字符串比对——不单靠模型的自我判断。
 * ★ 没配视觉模型 ⇒ `{ verdict: 'unverified' }`：调用方决定降级（对话里可用，但要标「未经看图核验」；出题里不用）。
 */
import { aiJson } from '../ai/gateway.js';

export type ImageMatch = 'yes' | 'partial' | 'no';

export interface ImageVerdict {
  match: ImageMatch;
  /** 一句话：图里画的是什么（给日志和学习者的替代文本用） */
  depicts: string;
  /** 图中可读的文字（尽量原样，没有为空串） */
  textInImage: string;
  /** 仅出题：模型认为图会不会直接暴露答案 */
  revealsAnswer: boolean;
}

export type VerifyOutcome =
  | { verdict: 'checked'; result: ImageVerdict; leak: boolean }
  | { verdict: 'unverified'; reason: string };

const SYSTEM = `你在帮一个学习应用挑配图。给你一张图和一个主题，判断这张图是否真的在展示这个主题。
判定：
- yes：图的主体就是这个主题（或它的标准示意图/照片），学习者一看就能对上；主题必须占画面主要部分，前景是人物合影、新闻活动、参观留影的一律不算 yes。
- partial：相关但不准（只是其中一部分、是更大的场景、或是相近但不同的东西只占一部分）。
- no：不是这个东西（相近概念、无关图片、广告海报、以文字为主的图）。
相近概念一律判 no（例如要「线粒体」给了「叶绿体」，要「火星」给了「金星」）。
同时报告图中能读到的文字（原样抄写，最多 80 个字；文字很多时只抄最醒目的标题和标注；没有就空串）。
只输出一个 JSON：{"match":"yes|partial|no","depicts":"一句话说明图里是什么","text_in_image":"…","reveals_answer":true或false}`;

export function parseImageVerdict(raw: string): ImageVerdict | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const match = o.match;
    if (match !== 'yes' && match !== 'partial' && match !== 'no') return null;
    return {
      match,
      depicts: typeof o.depicts === 'string' ? o.depicts.slice(0, 200) : '',
      textInImage: typeof o.text_in_image === 'string' ? o.text_in_image.slice(0, 500) : '',
      revealsAnswer: o.reveals_answer === true,
    };
  } catch {
    return null;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}]/gu, '');

/** 服务端自己的泄露判定：答案（≥2 字）原样出现在图中文字里，或模型自认会暴露答案 */
export function leaksAnswer(v: ImageVerdict, answers: readonly string[]): boolean {
  if (v.revealsAnswer) return true;
  const text = norm(v.textInImage);
  if (!text) return false;
  return answers.some((a) => {
    const n = norm(a);
    return n.length >= 2 && text.includes(n);
  });
}

export async function verifyImage(opts: {
  bytes: Uint8Array;
  mime: string;
  subject: string;
  /** 出题配图：题干与答案（给了就检查泄露） */
  quiz?: { question: string; answers: string[] };
  ownerId: string | null;
  signal?: AbortSignal;
}): Promise<VerifyOutcome> {
  const dataUrl = `data:${opts.mime};base64,${Buffer.from(opts.bytes).toString('base64')}`;
  const ask = opts.quiz
    ? `主题：${opts.subject}\n这张图要配在这道题上：${opts.quiz.question}\n正确答案：${opts.quiz.answers.join('；')}\n若学生看图就能直接读出或认出答案（图中写着答案、标注指明了答案），reveals_answer 为 true。`
    : `主题：${opts.subject}\nreveals_answer 固定填 false。`;
  const r = await aiJson({
    purpose: 'image.verify',
    ownerId: opts.ownerId,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: [{ type: 'text', text: ask }, { type: 'image_url', image_url: { url: dataUrl } }] },
    ],
    parse: parseImageVerdict,
    repairHint: '只输出那一个 JSON 对象，match 只能是 yes / partial / no。',
    temperature: 0,
    // ★ 400 不够：元素周期表这类满屏文字的图，模型会把字全抄进 text_in_image，JSON 被截断（首轮评测唯一的失败）
    maxTokens: 800,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!r.ok) return { verdict: 'unverified', reason: r.reason === 'no-model' ? '没有配置视觉模型' : r.error };
  return { verdict: 'checked', result: r.value, leak: opts.quiz ? leaksAnswer(r.value, opts.quiz.answers) : false };
}
