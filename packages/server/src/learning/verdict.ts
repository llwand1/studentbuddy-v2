/**
 * learning/verdict — [VERDICT] 协议：流式闸门 + 解析 + 归一化（纯函数、零 IO、可单测）。
 * COGNITIVE-EVOLUTION-SPEC v1.1 §6.1/§6.3（WBS 任务 3）。
 *
 * 闸门保证 [VERDICT] 段既不上屏也不落 messages——维持 flow.ts「屏上文本 == 库内文本」铁律；
 * parse/normalize 与 parseQuizBlock/parseTermsBlock 同族容错；met 字段为 v1.1 证据式判定，
 * 容错三态（非字符串数组丢字段 / 超 3 截断 / 空数组合法=诚实档）+ 双空兜底见 §6.2 反馈纪律。
 */
import type { Verdict } from '@sb/shared';

export const VERDICT_OPEN = '[VERDICT]';
export const VERDICT_CLOSE = '[/VERDICT]';

/** §6.1：verdict 面向用户，≤500 字（超长截断，不丢整块） */
const MAX_VERDICT_CHARS = 500;
/** v1.1 §6.1：met 每条须可在本轮原话指认，≤3 条（再多是灌水，截断） */
const MAX_MET_ITEMS = 3;

export interface GateOutcome {
  /** 可上屏且入 acc 的文本（判定段与悬空标记候选不在此列） */
  visible: string;
  /** 完整 VERDICT 块正文（OPEN/CLOSE 之间的原文，可能含围栏/杂质——交给 parseVerdictBlock） */
  blocks: string[];
}

/**
 * 流式闸门：assistant 输出逐 chunk 喂入，[VERDICT]...[/VERDICT] 段被摘出为 blocks，
 * 其余原样进 visible。支持一轮多块与跨 chunk 边界（保留最长真前缀缓冲，≤9 字符）。
 * 只处理 assistant 输出——用户输入不过闸门（§6.3 要点 3）。
 */
export class VerdictGate {
  /** 块外挂起：可能是 OPEN 真前缀的尾部（如 '[VER'），绝不过早吐上屏 */
  private pending = '';
  /** 是否在 VERDICT 块内 */
  private inBlock = false;
  /** 块内缓冲（含未闭合的 CLOSE 真前缀——都在 blockBuf 里，不丢） */
  private blockBuf = '';

  push(chunk: string): GateOutcome {
    const visible: string[] = [];
    const blocks: string[] = [];
    let rest = this.pending + chunk;
    this.pending = '';

    while (rest.length > 0) {
      if (!this.inBlock) {
        const open = rest.indexOf(VERDICT_OPEN);
        if (open === -1) {
          // 没遇到完整 OPEN：尾部若有「OPEN 的真前缀」先挂起，其余上屏
          const held = longestSuffixIsPrefix(rest, VERDICT_OPEN);
          if (held > 0) {
            visible.push(rest.slice(0, rest.length - held));
            this.pending = rest.slice(rest.length - held);
          } else {
            visible.push(rest);
          }
          rest = '';
        } else {
          visible.push(rest.slice(0, open));
          rest = rest.slice(open + VERDICT_OPEN.length);
          this.inBlock = true;
          this.blockBuf = '';
        }
      } else {
        // 块内先把新 chunk 并入缓冲再找 CLOSE——否则 '[/VERDICT]' 恰被切在两段之间时永远找不到
        this.blockBuf += rest;
        rest = '';
        const close = this.blockBuf.indexOf(VERDICT_CLOSE);
        if (close !== -1) {
          blocks.push(this.blockBuf.slice(0, close));
          rest = this.blockBuf.slice(close + VERDICT_CLOSE.length);
          this.blockBuf = '';
          this.inBlock = false;
        }
      }
    }
    return { visible: visible.join(''), blocks };
  }

  /**
   * 流收口。未闭合块（模型被截断在中途）把已吞文本原样吐回 visible——
   * §6.3 要点 2「绝不吞用户看到的字」，宁可将原始判定漏上屏也不静默丢正文。
   */
  flush(): GateOutcome {
    const visible: string[] = [];
    if (this.inBlock) {
      visible.push(VERDICT_OPEN + this.blockBuf);
      this.inBlock = false;
      this.blockBuf = '';
    }
    visible.push(this.pending);
    this.pending = '';
    return { visible: visible.join(''), blocks: [] };
  }
}

/** s 的尾部有多少字符恰好是 prefix 的真前缀（跨 chunk 的 '[VERDICT' 挂起依据） */
function longestSuffixIsPrefix(s: string, prefix: string): number {
  const max = Math.min(s.length, prefix.length - 1);
  for (let len = max; len > 0; len--) {
    if (prefix.startsWith(s.slice(s.length - len))) return len;
  }
  return 0;
}

/**
 * 解析单个 VERDICT 块原文为 Verdict 形状（容错阶梯，同 QUIZ 解析族）：
 * 带不带外层标记均可 → 剥 ```json 围栏 → string-aware 扫出首个平衡 JSON 对象 → JSON.parse。
 * 任何一步失败返回 null（ADR-4：调用方走降级，不落链不报错）。
 */
export function parseVerdictBlock(raw: string): Verdict | null {
  let body = raw;
  const m = body.match(/\[VERDICT\]([\s\S]*?)\[\/VERDICT\]/);
  if (m) body = m[1] ?? '';
  else if (!body.includes('"term"')) return null; // 快断：连字段名都没有，必非判定块
  const cleaned = body.replace(/```json|```/g, '').trim();
  const objText = extractFirstJsonObject(cleaned);
  if (!objText) return null;
  try {
    const parsed = JSON.parse(objText) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Verdict;
  } catch {
    return null;
  }
}

/**
 * 从首个 '{' 起扫到与之配对的 '}'（跳过字符串字面量内的花括号、处理反斜杠转义）——
 * verdict 文本里出现 '}' 不会截错对象（用例锁死）。找不到闭合返回 null（残缺=降级）。
 */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i] ?? '';
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 归一化（§6.1 字段约束 + §6.2 v1.1 met 三态与双空兜底），产出新对象、不改入参。
 * 返回 null = 丢弃该块（白名单外 / level 非数字 / verdict 缺失或空）；
 * 字段级脏值（gaps/met 非数组等）丢字段不丢块（ADR-4 降级面最小化）。
 */
export function normalizeVerdict(v: Verdict, allowed: Set<string>): Verdict | null {
  if (typeof v?.term !== 'string') return null;
  const term = v.term.trim();
  if (!allowed.has(term)) return null; // 模型乱判别词条 → 整块丢（§12 风险表）

  if (typeof v.level !== 'number' || !Number.isFinite(v.level)) return null;
  const level = Math.min(4, Math.max(0, Math.round(v.level))); // 0..4 钳制，小数四舍五入

  if (typeof v.verdict !== 'string' || v.verdict.trim() === '') return null;
  const verdict = v.verdict.trim().slice(0, MAX_VERDICT_CHARS);

  const out: Verdict = { term, level, verdict };

  if (Array.isArray(v.gaps)) {
    const gaps = v.gaps.filter((x): x is string => typeof x === 'string');
    if (gaps.length > 0) out.gaps = gaps; // 空数组视为无（§6.1），不落字段
  }

  if (typeof v.nextGoal === 'string' && v.nextGoal.trim() !== '') out.nextGoal = v.nextGoal;
  else if (v.nextGoal === null) out.nextGoal = null;

  if (typeof v.evidence === 'string' && v.evidence !== '') out.evidence = v.evidence;

  // v1.1 met 三态：合法=全字符串数组（超 3 截断）；空数组合法（诚实档）；
  // 非数组或含非字符串元素 → 丢字段（严格读 §6.1「非字符串数组→丢字段」）
  if (Array.isArray(v.met) && v.met.every((x) => typeof x === 'string')) {
    out.met = v.met.slice(0, MAX_MET_ITEMS);
  }

  // §6.2 反馈纪律兜底：met 与 gaps 双空 → met 显式置 []（前端渲染「本轮无新证据」，
  // 绝不静默吞卡）。等级上升轮双空同样命中——无害（空数组仅是诚实档信号，非错误）。
  if ((out.met === undefined || out.met.length === 0) && (out.gaps === undefined || out.gaps.length === 0)) {
    out.met = [];
  }

  return out;
}
