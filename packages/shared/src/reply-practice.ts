import type { QuizPayload } from './content-blocks.js';

/** The visible hint contains no question, reference answer or model instructions. */
export interface ReplyPracticeRef { messageId: string; title: string }

interface Section { kind: string; title: string; lines: string[] }
const KINDS = new Set(['CORE', 'ROUTE', 'STEP', 'EXAMPLE', 'PITFALL', 'CHECK']);

function plain(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').trim();
}

/** Read authored learning sections. Code/SVG fences never become question material. */
function sectionsOf(answer: string): Section[] {
  const sections: Section[] = [];
  let active: Section | undefined;
  let fence: string | undefined;
  for (const raw of answer.split(/\r?\n/)) {
    const line = raw.replace(/^\s*>\s?/, '');
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (marker) { fence = marker; continue; }
    const h = /^\[!([A-Z]+)\](?:\s+(.*))?\s*$/i.exec(line.trim());
    if (h) {
      active = KINDS.has(h[1]!.toUpperCase()) ? { kind: h[1]!.toUpperCase(), title: plain(h[2] ?? ''), lines: [] } : undefined;
      if (active) sections.push(active);
    } else if (active) active.lines.push(line);
  }
  return sections;
}

function subjectOf(section: Section, prompt: string): string | null {
  const generic = /^(核心结论|求解路线|推理步骤|具体例子|易错提醒|结果与验算|一句话(?:理解|结论)?|步骤\s*\d*|先.*再.*)$/;
  const title = section.title.replace(/^\d+[.、]\s*/, '');
  if (title.length >= 2 && title.length <= 100 && !generic.test(title)) return title;
  const subject = plain(prompt).replace(/^(请|帮我|给我|再)?\s*(详细|简单|简要)?\s*(解释(?:一下)?|讲解(?:一下)?|介绍(?:一下)?|说明(?:一下)?)\s*/, '').replace(/[。？！?！]+$/, '').trim();
  if (subject.length < 2 || subject.length > 160 || /^(继续|再讲|换个|再解释|好的|谢谢|嗯|是的)/.test(subject)) return null;
  return subject;
}

/**
 * A source-backed retrieval exercise, not a new simulated/real exam question.
 * Reference points are copied from the completed answer; no additional LLM call.
 * Empty, partial, oversized and non-learning replies produce no promise or hint.
 */
export function extractReplyPractice(prompt: string, answer: string): QuizPayload | null {
  if (!answer || answer.length > 30_000 || /（(?:已停止|生成中断)）|工具调用已达上限|上下文预算已满/.test(answer)) return null;
  const sections = sectionsOf(answer);
  const primary = sections.find((s) => (s.kind === 'CORE' || s.kind === 'ROUTE') && plain(s.lines.join('\n')).length >= 24);
  if (!primary) return null;
  const subject = subjectOf(primary, prompt);
  if (!subject) return null;
  const relevant = sections.filter((s) => s === primary || ['STEP', 'EXAMPLE', 'PITFALL', 'CHECK'].includes(s.kind));
  const reference = [...new Set(relevant.map((s) => s.lines.filter((line) => !/[？?]\s*$/.test(line)).join('\n').trim()).filter(Boolean))].join('\n\n');
  if (reference.length < 40 || reference.length > 8_000) return null;
  const check = sections.filter((s) => s.kind === 'CHECK').flatMap((s) => s.lines)
    .map((line) => plain(line).replace(/^\s*(?:[-+]|\d+[.、])\s*/, ''))
    .find((line) => line.length >= 10 && line.length <= 500 && /[？?]$/.test(line) &&
      !/上文|上述|如图|这张图|上面的|下图|要不要|是否继续|你想|出题|继续聊/.test(line));
  const task = primary.kind === 'ROUTE' && prompt.length >= 8 && prompt.length <= 2_000 &&
    /求|解|计算|化简|证明|比较|分析/.test(prompt) && !/如图|图中|这道题|上题|上面|继续|刚才/.test(prompt) ? plain(prompt) : null;
  const question = check ? `围绕「${subject}」，${check}` : primary.kind === 'ROUTE'
    ? task ? `不看讲解，完成下面的问题，并说明关键步骤与检验方法：\n\n${task}`
      : `不看讲解，复述「${subject}」的关键步骤，并说明每一步的依据与检验方法。`
    : `不看讲解，请用自己的话解释「${subject}」的核心含义与关键性质。`;
  return { title: `本次讲解 · ${subject}`, questions: [{
    type: 'essay', question, answer: reference,
    explanation: '参考要点来自本次讲解。用自己的话表达即可；先核对核心含义，再核对关键条件与推理。',
    source: { kind: 'ai', title: '由本次回复提炼的回忆练习' }, tier: 'basic',
  }] };
}

/** Narrow, affirmative requests only. New subjects, multiple questions and exam requests stay on the existing engine. */
export function isReplyPracticeRequest(text: string): boolean {
  const t = text.trim().replace(/[。！!？?]+$/, '');
  return /^(?:请|那|那么|现在|好[的啊]?[,，]?\s*)?(?:根据(?:刚才|本次|这次|上面)(?:的)?(?:回答|讲解|内容)[,，]?\s*)?(?:出(?:一|1)?(?:道)?题(?:吧)?|考(?:考)?我(?:吧)?|来(?:一|1)道(?:练习)?题|练(?:习)?(?:一|1)下|巩固一下)$/.test(t);
}
