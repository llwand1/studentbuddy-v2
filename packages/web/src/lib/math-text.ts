/** 常见教学公式转为可读符号；未知命令/残缺括号整式回退，不猜数学含义。 */
const SYMBOLS: Record<string, string> = {
  times: '×', cdot: '·', div: '÷', pm: '±', le: '≤', leq: '≤', ge: '≥', geq: '≥',
  neq: '≠', approx: '≈', infty: '∞', to: '→', rightarrow: '→', sum: '∑', int: '∫',
  alpha: 'α', beta: 'β', gamma: 'γ', theta: 'θ', pi: 'π', Delta: 'Δ', lambda: 'λ',
  mu: 'μ', sigma: 'σ', rho: 'ρ', omega: 'ω',
};
export function readableMath(code: string): string | null {
  if (!code.trim() || code.length > 4000) return null;
  let at = 0;
  const group = (depth: number): string => {
    while (/\s/.test(code[at] ?? '') && at < code.length) at++;
    if (code[at++] !== '{') throw new Error('group');
    return sequence(depth + 1, true);
  };
  const sequence = (depth: number, closing = false): string => {
    if (depth > 12) throw new Error('depth');
    let out = '';
    while (at < code.length) {
      const c = code[at++] ?? '';
      if (c === '}') { if (!closing) throw new Error('brace'); return out; }
      if (c === '{') { at--; out += group(depth); continue; }
      if ((c === '^' || c === '_') && code[at] === '{') {
        const sub = group(depth); out += c + (sub.length === 1 ? sub : '(' + sub + ')'); continue;
      }
      if (c !== '\\') { out += c; continue; }
      const command = /^(?:[A-Za-z]+|[ ,!;:{}%#_$\\])/.exec(code.slice(at))?.[0];
      if (!command) throw new Error('command');
      at += command.length;
      if (command === 'frac') { const n = group(depth); const d = group(depth); out += '(' + n + ')/(' + d + ')'; }
      else if (command === 'sqrt') out += '√(' + group(depth) + ')';
      else if (['boxed', 'text', 'mathrm', 'operatorname'].includes(command)) out += group(depth);
      else if (command === 'left' || command === 'right') continue;
      else if (SYMBOLS[command]) out += SYMBOLS[command];
      else if (/^[ ,!;:]$/.test(command)) out += ' ';
      else if (/^[{}%#_$\\]$/.test(command)) out += command;
      else throw new Error('unsupported');
    }
    if (closing) throw new Error('unclosed');
    return out;
  };
  try { return sequence(0).trim(); } catch { return null; }
}
