/** 提取短结构化回答；只修确定非法的字符串转义，不猜内容或补截断。 */
import { repairJsonEscapes } from './quiz-json-repair.js';

/** 合法 JSON 的字符串结束后只能接这些分隔符；其余引号只能作为字符串文字保留。 */
function escapeInnerQuotes(src: string): string {
  let out = '', inString = false, escaped = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (!inString) {
      if (ch === '"') inString = true;
    } else if (escaped) escaped = false;
    else if (ch === '\\') escaped = true;
    else if (ch === '"') {
      let next = i + 1;
      while (next < src.length && /\s/.test(src[next]!)) next += 1;
      if (next < src.length && !':,}]'.includes(src[next]!)) { out += '\\"'; continue; }
      inString = false;
    }
    out += ch;
  }
  return out;
}

export function extractJsonObject(text: string): unknown {
  const at = text.indexOf('{'), end = text.lastIndexOf('}');
  if (at < 0 || end <= at) return null;
  const src = text.slice(at, end + 1);
  try { return JSON.parse(src) as unknown; } catch { /* 保留合法 JSON 优先。 */ }
  const fixed = repairJsonEscapes(escapeInnerQuotes(src)).text;
  if (fixed === src) return null;
  try { return JSON.parse(fixed) as unknown; } catch { return null; }
}
