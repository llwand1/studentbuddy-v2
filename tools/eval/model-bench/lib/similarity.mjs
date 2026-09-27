/**
 * evals/lib/similarity — 文本相似度(复刻套件的核心度量)。
 *
 * textSim = 0.7 × 字符 bigram Dice + 0.3 × LCS 比率,归一化后大小写/空白/标点不敏感。
 * 选中文友好的字符级度量而非分词:零依赖、确定性、中英通吃;
 * Dice 抓"用词重合",LCS 抓"语序保持"——复刻题既要词对也要序对。
 */

/** 归一化:去空白/标点/大小写,只留字母数字(含 CJK) */
export const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

function bigramCounts(t) {
  const m = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const b = t.slice(i, i + 2);
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  return m;
}

/** 字符 bigram Dice 系数(多重集版) */
export function diceBigram(a, b) {
  const ta = norm(a);
  const tb = norm(b);
  if (ta === tb) return 1;
  if (ta.length < 2 || tb.length < 2) return ta === tb ? 1 : 0;
  const ma = bigramCounts(ta);
  const mb = bigramCounts(tb);
  let inter = 0;
  for (const [k, v] of ma) inter += Math.min(v, mb.get(k) ?? 0);
  return (2 * inter) / (ta.length - 1 + tb.length - 1);
}

/** 最长公共子序列比率(截断 400 字符防 O(n²) 失控) */
export function lcsRatio(a, b) {
  const ta = norm(a).slice(0, 400);
  const tb = norm(b).slice(0, 400);
  if (ta === tb) return 1;
  if (!ta.length || !tb.length) return 0;
  let prev = new Array(tb.length + 1).fill(0);
  for (let i = 1; i <= ta.length; i++) {
    const cur = new Array(tb.length + 1).fill(0);
    for (let j = 1; j <= tb.length; j++)
      cur[j] = ta[i - 1] === tb[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[tb.length] / Math.max(ta.length, tb.length);
}

/** 综合文本相似度 0..1 */
export function textSim(a, b) {
  const ta = norm(a);
  const tb = norm(b);
  if (!ta.length && !tb.length) return 1;
  if (!ta.length || !tb.length) return 0;
  if (ta === tb) return 1;
  return 0.7 * diceBigram(a, b) + 0.3 * lcsRatio(a, b);
}

/**
 * 集合相似度(选项组/填空答案组):贪心最优配对的相似度均值,
 * 分母取较大集合大小 ⇒ 多出/缺失的元素直接稀释得分。
 */
export function setSim(A, B) {
  const a = (A ?? []).map(String);
  const b = (B ?? []).map(String);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const used = new Set();
  let sum = 0;
  for (const x of a) {
    let best = -1;
    let bestSim = 0;
    for (let j = 0; j < b.length; j++) {
      if (used.has(j)) continue;
      const s = textSim(x, b[j]);
      if (s > bestSim) {
        bestSim = s;
        best = j;
      }
    }
    if (best >= 0) {
      used.add(best);
      sum += bestSim;
    }
  }
  return sum / Math.max(a.length, b.length);
}
