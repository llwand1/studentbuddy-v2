/**
 * tools/eval/runners/complete — 「题目自包含」评测的**评分侧**（生成侧见 `complete-gen.mts`，读数见 `docs/eval/complete.md`）。
 *
 * 输入：两臂的生成录制件（基线＝修复前提交，本分支）＋数据集里人工手写的参考题。
 * 评分：**卡面评审员**（另一个模型，直接 HTTP，不走产品链路）只看学生会看到的内容：
 *   材料、图（视觉评审员时送真图）、题干、选项；判「学生只看这张卡，不查任何别处，能不能作答」，
 *   并对选择题盲解。同一个评审员也给人工参考题打分——那是评审员自己的标尺（参考题应当全部自包含）。
 * 另有冻结版正则（`complete-eval-metrics.ts`），与产品检测器分开维护。
 *
 * ★ 评审员配置全走环境变量（key 只活在进程环境里，不落盘、不打印）：
 *   SB_JUDGE_BASE_URL / SB_JUDGE_API_KEY / SB_JUDGE_MODEL（缺省回退到 SB_EVAL_*），SB_JUDGE_VISION=1 送图。
 * ★ 评审结果按「模型＋卡面内容＋图哈希」缓存到 `reports/complete-judge-cache.json`：
 *   断点续跑不重复花额度，`--replay` 也靠它零额度重算。
 * ★ 评审员失败（限流/解析失败）留在分母里，不静默丢——见 `summarizeArm`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  frozenDetect, parseJudgement, pickAgrees, ratio, renderCompleteSummary, summarizeArm,
  type Channel, type EvalCard, type Judgement, type JudgedCard, type Need, type ReferenceSummary,
} from '../../../packages/server/src/learning/complete-eval-metrics.js';
import type { CompleteCase, GenFile } from './complete-gen.mts';

interface RefCase extends CompleteCase {
  reference: {
    type: string; question: string; material?: string; options?: string[]; answer: unknown; svg?: string;
    figure?: { file: string }; sources: unknown[];
  };
}

const SYSTEM = `你是严格的题目质检员。下面是学生在练习界面上看到的一张题卡：可能有「材料」「图」，然后是题干和选项。
假设学生**只有这张题卡**——没有课本、没有别的网页、看不到题卡之外的任何东西——请判断：这道题能不能作答？
- 题干里出现「根据材料/阅读下文/如图/下表/上述数据」之类的说法，但题卡上没有对应的材料、图或表格数据 ⇒ 不能作答。
- 材料/表格数据/图在题卡上，或题干本身已把所需信息写全（如直接引用了完整的句子、给出了全部数据）⇒ 能作答。
- 纯概念题、事实/知识回忆题（如「2023年GDP约多少」「某诗的下一句」）：只要题干**没有指向题卡外的材料**，学生凭学科知识就能作答 ⇒ 能作答，**不要因为「需要记忆」判缺**。
- 填空/解答题没有选项是正常的；材料只有文字版时，「听对话」之类的措辞不算缺失。
- 没有引用词、但缺了必要的数据/文段（如「该班成绩…」而没给数据）⇒ 不能作答。
- 附了图片时，图是否足以支撑题干所问，也要看（图与题干无关、或图里没有题干所指的内容 ⇒ 不能作答，missing 填 figure）。
另外，如果是选择题，请**不看任何答案**，选出你认为正确的选项（能作答才选；不能作答给 null）。
只输出 JSON：{"self_contained":true|false,"missing":"none|passage|figure|table|other","reason":"一句话","pick":["B"]或null}`;

const debug = (m: string): void => { if (process.env.SB_JUDGE_DEBUG) console.log(`  [judge] ${m}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex').slice(0, 20);

function cardText(c: EvalCard): string {
  const opts = c.options?.length ? `\n选项：\n${c.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o.replace(/^[A-D][.、．]\s*/, '')}`).join('\n')}` : '';
  const fig = c.imageFile ? '\n【题卡附图见下】' : c.svgSource ? `\n【题卡附示意图（SVG 源码）】\n${c.svgSource}` : '';
  return `${c.material ? `【材料】\n${c.material}\n\n` : ''}${fig ? `${fig}\n\n` : ''}【题干】${c.question}${opts}`;
}

interface JudgeCfg { base: string; key: string; model: string; vision: boolean }

function judgeCfg(): JudgeCfg {
  const base = process.env.SB_JUDGE_BASE_URL ?? process.env.SB_EVAL_BASE_URL;
  const key = process.env.SB_JUDGE_API_KEY ?? process.env.SB_EVAL_API_KEY;
  const model = process.env.SB_JUDGE_MODEL ?? 'agnes-3.0-flash';
  if (!base || !key) throw new Error('缺少评审员配置：设置 SB_JUDGE_BASE_URL / SB_JUDGE_API_KEY（或 SB_EVAL_*）');
  return { base: base.replace(/\/+$/, ''), key, model, vision: process.env.SB_JUDGE_VISION === '1' };
}

type Cache = Record<string, Judgement | null>;

async function callJudge(cfg: JudgeCfg, c: EvalCard, imgBytes: Buffer | null, mime: string): Promise<Judgement | null> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: cardText(c) }];
  if (cfg.vision && imgBytes) content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${imgBytes.toString('base64')}` } });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(`${cfg.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({ model: cfg.model, temperature: 0, max_tokens: 6000, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }] }),
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status === 429 || res.status >= 500) {
        await sleep(6_000 * (attempt + 1));
        continue;
      }
      if (!res.ok) { debug(`HTTP ${res.status}`); return null; }
      const body = (await res.json()) as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> };
      const text = body.choices?.[0]?.message?.content ?? '';
      const j = parseJudgement(text, c.options?.length ?? 0);
      if (j) return j;
      debug(`unparsable finish=${body.choices?.[0]?.finish_reason} len=${text.length} head=${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    } catch (err) {
      debug(`throw ${err instanceof Error ? err.message : String(err)}`);
      await sleep(3_000);
    }
  }
  return null;
}

async function judgeAll(cards: Array<{ key: string; card: EvalCard; imgAbs: string | null }>, cfg: JudgeCfg, cacheFile: string, replay: boolean): Promise<Map<string, Judgement | null>> {
  const cache: Cache = fs.existsSync(cacheFile) ? (JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Cache) : {};
  const out = new Map<string, Judgement | null>();
  const todo: typeof cards = [];
  for (const it of cards) {
    const img = cfg.vision && it.imgAbs && fs.existsSync(it.imgAbs) ? sha(fs.readFileSync(it.imgAbs)) : '';
    const k = `${cfg.model}|${cfg.vision ? 'v' : 't'}|${sha(SYSTEM)}|${sha(cardText(it.card))}|${img}`;
    (it as { ck?: string }).ck = k;
    if (k in cache && cache[k] !== null) out.set(it.key, cache[k]!);
    else if (replay) out.set(it.key, null);
    else todo.push(it);
  }
  let done = 0;
  const workers = Array.from({ length: 3 }, async () => {
    for (let it = todo.shift(); it; it = todo.shift()) {
      const abs = it.imgAbs && fs.existsSync(it.imgAbs) ? fs.readFileSync(it.imgAbs) : null;
      const mime = it.imgAbs?.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const j = await callJudge(cfg, it.card, abs, mime);
      cache[(it as { ck?: string }).ck!] = j;
      out.set(it.key, j);
      done += 1;
      if (done % 10 === 0) {
        fs.writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');
        console.log(`  评审 ${done}/${done + todo.length}`);
      }
    }
  });
  await Promise.all(workers);
  fs.writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');
  return out;
}

export interface CompleteScoring {
  md: string;
  base: ReturnType<typeof summarizeArm>;
}

export async function runCompleteScoring(opts: {
  dataset: string; baseFile: string; fixFile: string; reportsDir: string; replay: boolean; date: string;
}): Promise<{ md: string; detail: unknown }> {
  const ds = JSON.parse(fs.readFileSync(opts.dataset, 'utf8')) as { version: string; cases: RefCase[] };
  const needOf = (id: string): Need => ds.cases.find((c) => c.id === id)?.need ?? 'none';
  const base = JSON.parse(fs.readFileSync(opts.baseFile, 'utf8')) as GenFile;
  const fix = JSON.parse(fs.readFileSync(opts.fixFile, 'utf8')) as GenFile;
  const cfg = judgeCfg();
  const dsDir = path.dirname(opts.dataset);

  const items: Array<{ key: string; card: EvalCard; imgAbs: string | null }> = [];
  const push = (arm: string, r: GenFile['records'][number], i: number) => {
    const c = r.cards[i]!;
    items.push({ key: `${arm}|${r.caseId}|${r.channel}|${i}`, card: c, imgAbs: c.imageFile ? path.join(opts.reportsDir, c.imageFile) : null });
  };
  for (const [arm, f] of [['base', base], ['fix', fix]] as const) for (const r of f.records) r.cards.forEach((c, i) => (c.ok === false ? undefined : push(arm, r, i)));
  const refCards = ds.cases.map((c) => {
    const r = c.reference;
    const card: EvalCard = {
      type: r.type, question: r.question, hasFigure: !!r.figure || !!r.svg,
      ...(r.material ? { material: r.material } : {}),
      ...(r.options ? { options: r.options } : {}),
      ...(Array.isArray(r.answer) && r.options ? { answer: (r.answer as unknown[]).filter((x): x is number => typeof x === 'number') } : {}),
      ...(r.figure ? { imageFile: r.figure.file } : r.svg ? { svgSource: r.svg } : {}),
    };
    items.push({ key: `ref|${c.id}`, card, imgAbs: r.figure ? path.join(dsDir, 'complete-v1', r.figure.file) : null });
    return { c, card };
  });

  console.log(`评审员 ${cfg.model}（${cfg.vision ? '带图' : '仅文字'}）：${items.length} 张卡${opts.replay ? '（离线重算）' : ''}`);
  const judged = await judgeAll(items, cfg, path.join(opts.reportsDir, 'complete-judge-cache.json'), opts.replay);

  const rowsOf = (arm: 'base' | 'fix', f: GenFile, channel: Channel): { recs: GenFile['records']; rows: JudgedCard[] } => {
    const recs = f.records.filter((r) => r.channel === channel);
    const rows: JudgedCard[] = [];
    for (const r of recs) {
      r.cards.forEach((card, i) => {
        rows.push({ caseId: r.caseId, channel, need: needOf(r.caseId), card, judged: card.ok === false ? null : (judged.get(`${arm}|${r.caseId}|${r.channel}|${i}`) ?? null), frozenDangling: card.ok === false ? false : frozenDetect(card) });
      });
    }
    return { recs, rows };
  };
  const sum = (arm: 'base' | 'fix', f: GenFile, ch: Channel) => {
    const { recs, rows } = rowsOf(arm, f, ch);
    return summarizeArm(recs, rows, needOf);
  };
  const b = { gen: sum('base', base, 'gen'), collect: sum('base', base, 'collect') };
  const x = { gen: sum('fix', fix, 'gen'), collect: sum('fix', fix, 'collect') };

  const refJ = refCards.map(({ c, card }) => ({ c, card, j: judged.get(`ref|${c.id}`) ?? null }));
  const refOk = refJ.filter((r) => r.j);
  const choice = refOk.filter((r) => r.j!.selfContained && r.card.answer?.length);
  const ref: ReferenceSummary = {
    n: refCards.length,
    selfContained: ratio(refOk.filter((r) => r.j!.selfContained).length, refOk.length),
    blindAgree: ratio(choice.filter((r) => pickAgrees(r.j!, r.card.answer!)).length, choice.length),
    fromWeb: ds.cases.filter((c) => c.reference.sources.length > 0).length,
    composed: ds.cases.filter((c) => c.reference.sources.length === 0).length,
  };
  const md = renderCompleteSummary(b, x, ref, {
    date: opts.date, model: fix.model, judgeModel: cfg.model, judgeVision: cfg.vision, dataset: ds.version,
    baseSha: base.sha ?? '—', fixSha: fix.sha ?? '—', replay: opts.replay,
  });
  const detail = { refNotSelfContained: refJ.filter((r) => r.j && !r.j.selfContained).map((r) => ({ id: r.c.id, missing: r.j!.missing, reason: r.j!.reason })), refJudgeFailures: refJ.filter((r) => !r.j).map((r) => r.c.id) };
  // 逐卡明细（gitignored 的 reports/ 下）：每张卡的评审结论，供人复核，公开文档只放汇总
  const cards = (['base', 'fix'] as const).flatMap((arm) => (['gen', 'collect'] as const).flatMap((ch) =>
    rowsOf(arm, arm === 'base' ? base : fix, ch).rows.map((r) => ({
      arm, channel: ch, caseId: r.caseId, need: r.need, question: r.card.question.slice(0, 80), hasMaterial: !!r.card.material,
      hasFigure: r.card.hasFigure, rejected: r.card.ok === false, frozenDangling: r.frozenDangling,
      judged: r.judged ? { selfContained: r.judged.selfContained, missing: r.judged.missing, reason: r.judged.reason } : null,
    }))));
  fs.writeFileSync(path.join(opts.reportsDir, 'complete-detail.json'), JSON.stringify(cards, null, 1), 'utf8');
  return { md, detail };
}
