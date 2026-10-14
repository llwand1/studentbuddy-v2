/** continent-questions: split domain module; compatible exports remain at continent.ts. */
import type { ContinentTermLike } from './continent-core.js';
import { continentHash } from './continent-core.js';
import type { ContinentQType } from './continent-core.js';
import { speciesTypes } from './continent-monsters.js';

// ── 本地出题器（零 AI / 零成本 / 离线可用）─────────────────────────────────────
// 大陆自带出题器：`term` + `definition` 本地造题。故本段**不依赖任何模型**。

/** 情景题的四个情境框（照抄桌面 demo 的 `SCENE_FRAME`，一字未改口径） */
export const CONTINENT_SCENE_FRAMES: readonly string[] = [
  '情境：你在给同学讲这一节，被追问到这个词条——',
  '情境：项目答辩现场，老师顺着这个词条继续往下问——',
  '情境：同伴在群里提问，你想用一个判断回答他——',
  '情境：你在睡前自测，给自己出了一道题——',
];

/**
 * 一道大陆题（五型联合）。
 * ★ `scene`（情景题）是**「情境框 + 选择题干」的简化形态**（与 demo 的 `q_scene` 同形：
 *   demo 里它也是包一道 choice 再挂个 `frame`）。真机若要做「长情境 + 多轮追问」，
 *   动的应该是这一条的分支，而不是再加一种题型——图鉴槽位与题型序列都按 `ContinentQType` 走。
 */
export type ContinentQuestion =
  | { type: 'judge'; prompt: string; statement: string; answer: boolean }
  | { type: 'choice'; prompt: string; options: string[]; answerIndex: number }
  | { type: 'fill'; prompt: string; answer: string }
  /**
   * 连线题：`left` 固定序（题面），`right` 乱序（选项）；`answer[i]` = `left[i]` 应当连到的 `right` 下标。
   * 判分**要求全部连对**（连线题的语义就是「整张图连对」，允许部分对等于给了半分，用户会觉得赚了）。
   */
  | { type: 'match'; prompt: string; left: string[]; right: string[]; answer: number[] }
  | { type: 'scene'; frame: string; prompt: string; options: string[]; answerIndex: number };

/** 用户的作答（形状随题型；判分统一走 `gradeAnswer`，UI 不自己比） */
export type ContinentAnswer = boolean | number | string | number[];

/** 判分归一化：去空白 / 去中英标点 / 全角转半角 / 转小写（照抄桌面 demo 的 `norm_text` 口径） */
export function normText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、；：！？“”‘’（）【】《》,.;:!?"'()[\]<>~`·\-—_/\\|]/g, '');
}

/** 从池子里按稳定哈希挑 n 条**别的**词条（当干扰项）；同哈希按 id 兜底，保证确定性 */
function pickOthers<T extends ContinentTermLike>(
  pool: readonly T[],
  selfId: string,
  seed: string,
  n: number,
): T[] {
  return pool
    .filter((t) => t.id !== selfId)
    .map((t) => ({ t, k: continentHash(`${seed}|${t.id}`) }))
    .sort((a, b) => (a.k === b.k ? (a.t.id < b.t.id ? -1 : 1) : a.k - b.k))
    .slice(0, n)
    .map((x) => x.t);
}

/** 按稳定哈希重排（选项乱序但不能每次刷新都变） */
function stableOrder<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => continentHash(key(a)) - continentHash(key(b)));
}

/** 选择题干与选项（`choice` / `scene` 共用；两者的差别只有「有没有情境框」） */
function buildChoices(
  term: ContinentTermLike,
  pool: readonly ContinentTermLike[],
  seed: string,
  tag: string,
): { options: string[]; answerIndex: number } {
  const wrongs = pickOthers(pool, term.id, `${seed}|${tag}`, 3).map((t) => t.definition);
  const options = stableOrder([term.definition, ...wrongs], (d) => `${seed}|${tag}opt|${d}`);
  return { options, answerIndex: options.indexOf(term.definition) };
}

/**
 * 造一道题。五型全部有实现（`scene` 见头注 3 的简化形态）。
 * ★ 仍然可能返回 `null`（选项池太小、连线池不足）——调用方负责退到 `fill` 兜底
 *   （见 `buildMonsterQuestions`），从而「血条数 = 题数」这条永远成立。
 */
export function buildQuestion(
  type: ContinentQType,
  term: ContinentTermLike,
  pool: readonly ContinentTermLike[],
  seed: string = term.id,
): ContinentQuestion | null {
  switch (type) {
    case 'judge': {
      const wrong = pickOthers(pool, term.id, `${seed}|judge`, 1)[0];
      // 有干扰项时才可能出「错」题；池子里只有自己 ⇒ 只能出「对」题（不能让玩家无从判断）
      const makeTrue = !wrong || continentHash(`${seed}|judge|t`) % 2 === 0;
      const statement = makeTrue
        ? `${term.term} 的含义是：${term.definition}`
        : `${term.term} 的含义是：${wrong.definition}`;
      return { type: 'judge', prompt: '判断下面这句话对不对', statement, answer: makeTrue };
    }
    case 'choice': {
      return { type: 'choice', prompt: `「${term.term}」的意思是？`, ...buildChoices(term, pool, seed, 'choice') };
    }
    case 'fill': {
      // 释义里含词条名 ⇒ 挖空它（考「名 → 还原」）；不含 ⇒ 反过来由释义写出词条名
      const prompt = term.definition.includes(term.term)
        ? term.definition.split(term.term).join('____')
        : `根据释义写出词条：${term.definition}`;
      return { type: 'fill', prompt, answer: term.term };
    }
    case 'match': {
      const pairs = [term, ...pickOthers(pool, term.id, `${seed}|match`, 2)];
      if (pairs.length < 2) return null; // 连不起来（池子只有自己）⇒ 退到 fill 兜底
      const left = pairs.map((p) => p.term);
      const right = stableOrder(pairs.map((p) => p.definition), (d) => `${seed}|right|${d}`);
      return {
        type: 'match',
        prompt: '把词条与它的释义连起来',
        left,
        right,
        answer: pairs.map((p) => right.indexOf(p.definition)),
      };
    }
    case 'scene': {
      // ★ 情境框由稳定哈希选（同 `speciesTypes` 的判断标准），不用随机 ⇒ 同一只怪每次进都是同一道题
      const frame =
        CONTINENT_SCENE_FRAMES[continentHash(`${seed}|frame`) % CONTINENT_SCENE_FRAMES.length] ??
        CONTINENT_SCENE_FRAMES[0] ??
        '';
      return {
        type: 'scene',
        frame,
        prompt: `有人这样问你：「${term.term}」到底指什么？`,
        ...buildChoices(term, pool, seed, 'scene'),
      };
    }
    default:
      // 词汇表之外的类型（将来登记了新题型但没实现时）：返回 null，由调用方退到 fill 兜底
      return null;
  }
}

/**
 * 一只怪的完整题组：**一型一道，题数 = 等级 = 血量**。
 * ★ 某型建不出时退到 `fill`（它只依赖词条自己，永远建得出）。
 */
export function buildMonsterQuestions(
  term: ContinentTermLike,
  level: number,
  pool: readonly ContinentTermLike[],
): ContinentQuestion[] {
  const types = speciesTypes(term.id, level);
  return types.map((type, i) => {
    const seed = `${term.id}#q${i}`;
    return (
      buildQuestion(type, term, pool, seed) ??
      buildQuestion('fill', term, pool, seed) ?? {
        type: 'fill' as const,
        prompt: `根据释义写出词条：${term.definition}`,
        answer: term.term,
      }
    );
  });
}

/** 判分（全仓唯一入口；UI 不自己比字符串——归一化口径只有这一份） */
export function gradeAnswer(q: ContinentQuestion, answer: ContinentAnswer): boolean {
  switch (q.type) {
    case 'judge':
      return typeof answer === 'boolean' && answer === q.answer;
    case 'choice':
    case 'scene':
      return typeof answer === 'number' && answer === q.answerIndex;
    case 'fill':
      return typeof answer === 'string' && normText(answer) !== '' && normText(answer) === normText(q.answer);
    case 'match': {
      if (!Array.isArray(answer) || answer.length !== q.answer.length) return false;
      return q.answer.every((v, i) => answer[i] === v);
    }
  }
}
