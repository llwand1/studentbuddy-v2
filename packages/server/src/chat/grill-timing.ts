import { choiceNudge } from './choice-nudge.js';

/** Only an unresolved route needs an opening decision; clear questions and chosen steps proceed. */
export function needsGrillOpening(text: string): boolean {
  const s = text.trim();
  if (/不要.*(追问|提问|问我)|直接(回答|讲解|给.*题)|don'?t ask|answer directly/i.test(s)) return false;
  if (choiceNudge(s)) return true;
  return /^(开始学习|带我学|我想学点东西|学点什么|我想复习(?:一下)?|考我|考考我|quiz me|grill me)[。！!？?\s]*$/i.test(s);
}

export function shouldOfferGrillNext(text: string, answer: string): boolean {
  return answer.trim().length >= 80 && !/^(谢谢|多谢|好的|收到|明白了|thanks|thank you|ok)[。！!\s]*$/i.test(text.trim())
    && !/\[QUIZ\]|\[SCENARIO\]/.test(answer);
}

export function shouldCloseGrill(opts: { grillMe?: boolean; signal?: AbortSignal; text: string }, answer: string,
  pending: boolean, rounds: Array<{ calls: Array<{ name: string }> }>): boolean {
  return opts.grillMe === true && !pending && !opts.signal?.aborted && shouldOfferGrillNext(opts.text, answer)
    && !rounds.some(r => r.calls.some(c => c.name === 'generate_quiz'));
}

export const GRILL_DIRECT = '（GrillMe 按需追问）用户的本次问题或下一步方向已明确，直接按这个目标展开，'
  + '不要再问学习方向、深度或形式；已有信息可以回答的问题不让用户重复选择。'
  + '需要练习时用正式出题工具；一次只聚焦一个知识缺口，先给适量提示。下一步路线由回答完成后的追问卡提供。';
