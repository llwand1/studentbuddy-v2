/**
 * learning/complete-eval-metrics — 「题目自包含」评测（`docs/eval/complete.md`）的**评分口径**（纯函数，进单测，CI 可跑）。
 *
 * ★ 评分器**不引用产品代码**（不 import `quiz-completeness.ts`）：拿被测对象自己的检测器给它自己打分，
 *   等于让它出卷自己判——它认不出的无头题永远读不出来。这里有两把独立的尺：
 *     ① `frozenDetect`：冻结版正则（v1，与产品那份**分别维护**），只看「引用了没给」；
 *     ② 卡面评审员（另一个模型）：只看学生会看到的内容，判「不查别处能不能作答」，并盲解选择题。
 * ★ 口径纪律（与 grade/vision 评测一致）：
 *   · 每个比率写 `n/d`，分母为 0 记 null（渲染成「—」），绝不写成 0%；
 *   · 评审员调用失败**留在分母里**（记 `judgeFailures`），不悄悄丢；
 *   · 盲解一致率只在「评审员认为自包含」的选择题上算——看不全题的盲解一致与否没有意义；
 *   · 用量按**这一 case 该通道的全部调用**求和；拿不到 ⇒ null。
 */

export type Need = 'passage' | 'figure' | 'table' | 'none';
export type Channel = 'gen' | 'collect';

/** 学生在题卡上会看到的东西（评审员的全部输入） */
export interface EvalCard {
  type: string;
  question: string;
  material?: string;
  options?: string[];
  /** 选择题：正确选项下标 */
  answer?: number[];
  /** 是否带图（svg 或 photo） */
  hasFigure: boolean;
  /** 图文件相对路径（有视觉评审员时随卡送图） */
  imageFile?: string;
  /** 模型自己画的 svg 源码（评审员按文字读；有 imageFile 时不填） */
  svgSource?: string;
  /** 仅 collect：产品是否放行（ok:false ＝ 预览里被拒） */
  ok?: boolean;
  reason?: string;
}

export interface GenRecord {
  caseId: string;
  channel: Channel;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  /** 传输/抛出的错误 */
  error?: string;
  /** 产品自己上报的失败原因（如 incomplete） */
  failure?: string;
  /** 产品闸门自报剔除了几道（基线没有这个字段 ⇒ null） */
  droppedByProduct: number | null;
  /** 模型输出解析失败时补跑过几次（用户看到失败会再点一次；两臂同规则）。缺省=1 */
  attempts?: number;
  cards: EvalCard[];
}

export type Missing = 'none' | 'passage' | 'figure' | 'table' | 'other';
export interface Judgement {
  selfContained: boolean;
  missing: Missing;
  reason: string;
  /** 评审员盲解选的下标；无法作答/非选择题 ⇒ null */
  pick: number[] | null;
}

// ───────────────────────────── 冻结检测器 v1 ─────────────────────────────

const FROZEN_REF =
  /(?:阅读|根据|依据|结合|据|由|读|分析)[^，。？！\n]{0,6}(?:材料|文段|语段|短文|文章|下表|下图|图|表格|对话)|如图|图中|下图|下表|表中|读图|上述材料|以上材料|上述数据|(?:the|this|above|following)\s+(?:passage|text|article|dialogue|figure|diagram|table|chart|map)\b/i;
const CJK = /[\u3400-\u9fff]/g;

/** 冻结版：题干/选项里有指向外部内容的说法，且卡上没有材料/图，去掉引用句后题干也撑不起 ⇒ 悬空 */
export function frozenDetect(c: Pick<EvalCard, 'question' | 'material' | 'options' | 'hasFigure'>): boolean {
  const surface = [c.question, ...(c.options ?? [])].join('\n');
  if (!FROZEN_REF.test(surface)) return false;
  if ((c.material ?? '').trim().length >= 12) return false;
  if (c.hasFigure) return false;
  const rest = c.question.split(/(?<=[。？！?!\n])/).filter((s) => !FROZEN_REF.test(s)).join('');
  const weight = (rest.match(CJK) ?? []).length + rest.replace(CJK, '').replace(/\s+/g, '').length / 3;
  return weight < 40;
}

// ───────────────────────────── 评审员输出解析 ─────────────────────────────

export function parseJudgement(raw: string, optionCount: number): Judgement | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    if (typeof o.self_contained !== 'boolean') return null;
    const missing = (['none', 'passage', 'figure', 'table', 'other'] as const).find((x) => x === o.missing) ?? (o.self_contained ? 'none' : 'other');
    const pickRaw = Array.isArray(o.pick) ? o.pick : typeof o.pick === 'string' ? [...o.pick.toUpperCase()] : null;
    const pick = pickRaw
      ? pickRaw
          .map((x) => (typeof x === 'number' ? x : typeof x === 'string' && /^[A-Za-z]$/.test(x) ? x.toUpperCase().charCodeAt(0) - 65 : -1))
          .filter((i) => i >= 0 && i < optionCount)
          .sort((a, b) => a - b)
      : null;
    return { selfContained: o.self_contained, missing: o.self_contained ? 'none' : missing === 'none' ? 'other' : missing, reason: String(o.reason ?? '').slice(0, 200), pick: pick && pick.length ? [...new Set(pick)] : null };
  } catch {
    return null;
  }
}

// ───────────────────────────── 汇总 ─────────────────────────────

export interface JudgedCard {
  caseId: string;
  channel: Channel;
  need: Need;
  card: EvalCard;
  /** null ⇒ 评审员调用/解析失败（留在分母里） */
  judged: Judgement | null;
  frozenDangling: boolean;
}

export interface Ratio {
  n: number;
  d: number;
}
export const ratio = (n: number, d: number): Ratio => ({ n, d });

export interface ArmSummary {
  cases: number;
  /** 至少交付 1 道题的 case 数 */
  casesWithDelivery: number;
  /** 交付的题数（collect 只数产品放行的） */
  delivered: number;
  /** collect：预览里被拒的候选数 */
  rejected: number;
  judgeFailures: number;
  /** 评审员：自包含题数 ／ 已评题数 */
  selfContained: Ratio;
  /** 冻结正则：判悬空的题数 ／ 交付题数 */
  frozenDangling: Ratio;
  /** 评审员：至少 1 道自包含题的 case 数 ／ case 数 */
  casesUsable: Ratio;
  /** 每 case 平均可用（自包含）题数 */
  usablePerCase: number | null;
  /** 选择题盲解一致（仅自包含题） */
  blindAgree: Ratio;
  /** 图依赖 case：交付题带图的比例 */
  figureAttached: Ratio;
  /** 图依赖 case：自包含题数 ／ 已评题数 */
  figureSelfContained: Ratio;
  /** 对照组（need=none）：自包含题数 ／ 已评题数——应≈100% */
  controlSelfContained: Ratio;
  /** 对照组：产品闸门自报剔除数 ／ (交付+剔除)——误杀；基线无此数据 ⇒ d=0 */
  controlDropped: Ratio;
  /** 缺失类别分布（评审员判不自包含的题） */
  missingBy: Record<Exclude<Missing, 'none'>, number>;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** 每道可用题耗多少 token（分母 0 ⇒ null） */
  tokensPerUsable: number | null;
  errors: number;
}

const pctile = (sorted: number[], p: number): number | null => (sorted.length === 0 ? null : (sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null));
const sumOrNull = (xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0);
};

/** 判断评审员的盲解与标答是否一致（集合相等） */
export function pickAgrees(judged: Judgement, answer: number[]): boolean {
  if (!judged.pick) return false;
  const a = [...answer].sort((x, y) => x - y);
  return a.length === judged.pick.length && a.every((v, i) => v === judged.pick![i]);
}

export function summarizeArm(records: GenRecord[], rows: JudgedCard[], needOf: (caseId: string) => Need): ArmSummary {
  const caseIds = [...new Set(records.map((r) => r.caseId))];
  const delivered = rows.filter((r) => r.channel === 'gen' || r.card.ok !== false);
  const judged = delivered.filter((r) => r.judged);
  const sc = judged.filter((r) => r.judged!.selfContained);
  const usableByCase = new Map<string, number>();
  for (const r of sc) usableByCase.set(r.caseId, (usableByCase.get(r.caseId) ?? 0) + 1);
  const choice = sc.filter((r) => (r.card.answer?.length ?? 0) > 0 && (r.card.options?.length ?? 0) > 0);
  const figRows = delivered.filter((r) => r.need === 'figure');
  const ctl = delivered.filter((r) => r.need === 'none');
  const ctlJudged = ctl.filter((r) => r.judged);
  const ctlRecs = records.filter((r) => needOf(r.caseId) === 'none');
  const dropped = ctlRecs.reduce((a, r) => a + (r.droppedByProduct ?? 0), 0);
  const droppedKnown = ctlRecs.some((r) => r.droppedByProduct !== null);
  const lat = caseIds.map((id) => records.filter((r) => r.caseId === id).reduce((a, r) => a + r.latencyMs, 0)).sort((a, b) => a - b);
  const prompt = sumOrNull(records.map((r) => r.promptTokens));
  const compl = sumOrNull(records.map((r) => r.completionTokens));
  const missingBy: ArmSummary['missingBy'] = { passage: 0, figure: 0, table: 0, other: 0 };
  for (const r of judged) if (!r.judged!.selfContained && r.judged!.missing !== 'none') missingBy[r.judged!.missing] += 1;
  return {
    cases: caseIds.length,
    casesWithDelivery: caseIds.filter((id) => delivered.some((r) => r.caseId === id)).length,
    delivered: delivered.length,
    rejected: rows.filter((r) => r.channel === 'collect' && r.card.ok === false).length,
    judgeFailures: delivered.length - judged.length,
    selfContained: ratio(sc.length, judged.length),
    frozenDangling: ratio(delivered.filter((r) => r.frozenDangling).length, delivered.length),
    casesUsable: ratio(caseIds.filter((id) => (usableByCase.get(id) ?? 0) > 0).length, caseIds.length),
    usablePerCase: caseIds.length ? sc.length / caseIds.length : null,
    blindAgree: ratio(choice.filter((r) => pickAgrees(r.judged!, r.card.answer!)).length, choice.length),
    figureAttached: ratio(figRows.filter((r) => r.card.hasFigure).length, figRows.length),
    figureSelfContained: ratio(figRows.filter((r) => r.judged?.selfContained).length, figRows.filter((r) => r.judged).length),
    controlSelfContained: ratio(ctlJudged.filter((r) => r.judged!.selfContained).length, ctlJudged.length),
    controlDropped: droppedKnown ? ratio(dropped, dropped + ctl.length) : ratio(0, 0),
    missingBy,
    latencyP50Ms: pctile(lat, 0.5),
    latencyP95Ms: pctile(lat, 0.95),
    promptTokens: prompt,
    completionTokens: compl,
    tokensPerUsable: sc.length > 0 && prompt !== null ? Math.round(((prompt ?? 0) + (compl ?? 0)) / sc.length) : null,
    errors: records.filter((r) => r.error).length,
  };
}

// ───────────────────────────── 渲染 ─────────────────────────────

const fmt = (r: Ratio): string => (r.d === 0 ? '—（无分母）' : `${r.n}/${r.d}（${((r.n / r.d) * 100).toFixed(1)}%）`);
const sec = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`);
const num = (n: number | null): string => (n === null ? '—' : n.toLocaleString('en-US'));
const one = (n: number | null): string => (n === null ? '—' : n.toFixed(2));

export interface RenderMeta {
  date: string;
  model: string;
  judgeModel: string;
  judgeVision: boolean;
  dataset: string;
  baseSha: string;
  fixSha: string;
  replay: boolean;
}

/** 参考题（作者手写）的自我核对：评审员对它们的判定，是评审员自己的标尺 */
export interface ReferenceSummary {
  n: number;
  selfContained: Ratio;
  blindAgree: Ratio;
  fromWeb: number;
  composed: number;
}

export function renderCompleteSummary(base: Record<Channel, ArmSummary>, fix: Record<Channel, ArmSummary>, ref: ReferenceSummary, m: RenderMeta): string {
  const row = (label: string, f: (s: ArmSummary) => string): string[] =>
    [`| ${label} | ${f(base.gen)} | ${f(fix.gen)} | ${f(base.collect)} | ${f(fix.collect)} |`];
  const lines = [
    `**${m.date}**｜被测模型 \`${m.model}\`｜评审员 \`${m.judgeModel}\`（${m.judgeVision ? '带图评审' : '仅文字评审，图题只看「有无图」'}）｜数据集 \`${m.dataset}\`｜${m.replay ? '离线重算' : '真调'}`,
    `基线＝\`${m.baseSha}\`（修复前）；本分支＝\`${m.fixSha}\``,
    '',
    '| 指标 | 出题·基线 | 出题·本分支 | 搜集·基线 | 搜集·本分支 |',
    '|---|---|---|---|---|',
    ...row('case 数（有交付）', (s) => `${s.cases}（${s.casesWithDelivery}）`),
    ...row('交付题数（搜集＝产品放行的）', (s) => String(s.delivered)),
    ...row('**自包含率**（评审员，越高越好）', (s) => fmt(s.selfContained)),
    ...row('冻结正则判悬空率（越低越好）', (s) => fmt(s.frozenDangling)),
    ...row('**有可用题的 case**（≥1 道自包含）', (s) => fmt(s.casesUsable)),
    ...row('每 case 可用题数', (s) => one(s.usablePerCase)),
    ...row('盲解一致率（自包含的选择题）', (s) => fmt(s.blindAgree)),
    ...row('图依赖 case：交付题带图率', (s) => fmt(s.figureAttached)),
    ...row('图依赖 case：自包含率', (s) => fmt(s.figureSelfContained)),
    ...row('对照组（无依赖）自包含率', (s) => fmt(s.controlSelfContained)),
    ...row('对照组被产品闸门剔除（误杀）', (s) => fmt(s.controlDropped)),
    ...row('搜集：预览里被拒的候选', (s) => String(s.rejected)),
    ...row('评审员判缺（文段/图/表/其他）', (s) => `${s.missingBy.passage}/${s.missingBy.figure}/${s.missingBy.table}/${s.missingBy.other}`),
    ...row('单 case 时延 p50／p95', (s) => `${sec(s.latencyP50Ms)}／${sec(s.latencyP95Ms)}`),
    ...row('token（输入／输出）', (s) => `${num(s.promptTokens)}／${num(s.completionTokens)}`),
    ...row('每道可用题 token', (s) => num(s.tokensPerUsable)),
    ...row('评审失败／调用出错', (s) => `${s.judgeFailures}／${s.errors}`),
    '',
    `**人工参考题**（${ref.n} 道，同一评审员打分）：自包含 ${fmt(ref.selfContained)}；盲解与标答一致 ${fmt(ref.blindAgree)}；其中真实检索 ${ref.fromWeb} 道、自编 ${ref.composed} 道。`,
  ];
  return lines.join('\n');
}
