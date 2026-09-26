/**
 * mix-report — 出题配比的展示文案（纯函数：组件只管挂上去，规则留在这里才可测）。
 * 契约 QuizMixReport 由服务端给出，本文件只做「说人话」，不重新判定缺什么。
 */
import type {
  QuizMix,
  QuizMixReport,
  QuizImageReport,
  QuizQuestion,
  QuizSearchReport,
  QuizSourceMix,
  QuizBlendReport,
  QuizRef,
  ScenarioMixResult,
} from '@sb/shared';
import { MIX_KINDS, MIX_KIND_LABELS, QUIZ_TYPES, QUIZ_TYPE_LABELS, mixTotal, sourceMixTotal } from '@sb/shared';

/** 「单选题 2 · 填空题 1 · 解答题 1」；数量为 0 的档位不展示 */
export function mixSummary(mix: QuizMix): string {
  const parts = QUIZ_TYPES.filter((t) => mix[t] > 0).map((t) => `${QUIZ_TYPE_LABELS[t]} ${mix[t]}`);
  return parts.length > 0 ? parts.join(' · ') : '未选题型';
}

/**
 * 出题配比摘要一行（对话页 composer 用；2026-09-26 从 `bank-view.ts` 搬来——那份的其余部分
 * （题库徽标 `bankBadge`）随题库页一起下线，只有这一句还在服务对话核）。
 * AI 侧摘要照旧；真题配了就并进同一行并预告「会慢」
 * （契约 QUIZ-BLEND-SPEC §8.3：collect 首版同步无进度条，提示必须如实）。
 */
export function mixTipText(ai: QuizMix, real: QuizSourceMix): string {
  const realTotal = real.single + real.multiple + real.fill + real.essay + real.scenario;
  return realTotal > 0 ? `${mixSummary(ai)}（真题 ${realTotal} 题；含现场搜集，出题可能更久）` : mixSummary(ai);
}

/** 出齐了返回 null；没出齐返回一句话（缺哪类、缺几道），UI 据此如实提示，绝不静默 */
export function shortfallText(report: QuizMixReport): string | null {
  if (report.matched) return null;
  const missing = QUIZ_TYPES.filter((t) => report.actual[t] < report.requested[t]);
  const detail = missing.map((t) => `${QUIZ_TYPE_LABELS[t]} ${report.requested[t] - report.actual[t]} 道`).join('、');
  return `模型只出了 ${mixTotal(report.actual)}/${mixTotal(report.requested)} 题（缺 ${detail}），可在设置页调整配比后重试`;
}

/**
 * 配图情况文案（v1.1，契约 §2.4）：开关开着却没图 / 图画坏了被丢 / 撞顶截断，都得说出来，不静默。
 * 返 null = 没什么要播报的（正常出图，或开关本来就关着——那不是损失）。
 * 同 shortfallText：判定全在服务端 report，本函数只负责说人话。
 */
export function imageNote(report?: QuizImageReport | null): string | null {
  if (!report || !report.on) return null;
  const parts: string[] = [];
  if (report.truncated) parts.push('模型输出没写完（多半是撞到长度上限），尾部不完整的题已丢弃，结果题数可能少于配比');
  if (report.droppedSvg > 0) parts.push(`${report.droppedSvg} 张图画得不完整或不合规，已只丢图保题`);
  if (report.delivered === 0 && parts.length === 0) parts.push('本次模型一题也没配图（它认为这些题不需要示意图，可重试或把题干写得更图形化）');
  return parts.length > 0 ? `配图：${parts.join('；')}。` : null;
}

/**
 * 联网情况文案（契约 docs/QUIZ-SEARCH-SPEC.md §2.7）：参考了几条、哪几家、一条也没取到，都要说出来。
 * 返 null = 没什么要播报的（本次本来就没联网——那不是损失，跟配图开关关着同理）。
 * 同 imageNote：判定全在服务端 report，本函数只负责说人话。
 */
export function searchNote(report?: QuizSearchReport | null): string | null {
  if (!report || !report.on) return null;
  if (report.count > 0) {
    const from = report.providers.filter((p) => p !== 'cache');
    return from.length > 0
      ? `联网：参考了 ${report.count} 条资料（来源 ${from.join('、')}）。`
      : `联网：参考了 ${report.count} 条资料（本次命中缓存）。`;
  }
  if (report.failed.length > 0) return `联网：这次没取到参考（${report.failed[0]}），题目基于模型自身知识出的。`;
  return '联网：没搜到可用参考，题目基于模型自身知识出的。';
}

/**
 * 本次参考来源清单（契约 docs/QUIZ-SEARCH-SPEC.md §2.8）：有命中才返非空，供页面渲染可点击来源区。
 * 与 `searchNote` 的分工：**有来源清单时由清单承担告知（可展开、可点），searchNote 只兜「没取到」**——
 * 两句话同时出现会说两遍同件事，故页面层二选一（见 ChatView 的 filter 处）。
 * URL 由服务端映射，本函数不校验、不补全，只做透传（前端不发明来源）。
 */
export function refsList(report?: QuizSearchReport | null): QuizRef[] {
  if (!report || !report.on) return [];
  return report.refs ?? [];
}

/**
 * 情景题逐套结果文案（SCENARIO-SPEC §6.1）：配比里的情景档按套逐一生成，部分失败必须说出来，不静默。
 * 成功的套卡片已进聊天流（sessionId 场景），这里仍报套数——「一共出了几套」在卡片上看不出来。
 * 返 null = 本次配比没要情景题，没什么要播报的。
 */
export function scenarioMixNote(results?: ScenarioMixResult[] | null): string | null {
  if (!results || results.length === 0) return null;
  const ok = results.filter((r) => r.ok).length;
  const total = results.length;
  if (ok === total) return `情景题：${total} 套已生成${total > 1 ? '，都在本次对话里' : '，已进本次对话'}。`;
  const failures = results.filter((r) => !r.ok);
  const reason = failures.some((f) => f.failure === 'no-model')
    ? '出题模型没绑定，先到设置页给「出题」绑定模型'
    : '模型输出没解析成情景题，可重试';
  return ok === 0
    ? `情景题：${total} 套都没出成——${reason}。`
    : `情景题：成功 ${ok}/${total} 套，失败 ${total - ok} 套（${reason}）。`;
}

/**
 * 真题实际出自几个网页：优先按**题面的 `source.url` 去重**（准确到题）；拿不到题面时退回
 * `collect.pages` 里抓取成功的页数——那只是**读过**的页数，是上限而非实际出处，仅作兜底。
 * ★ 为什么要分开算：抓了 3 页但只有 1 页摘出题时，报「来自 3 个网页」就是**假账**（ADR-5 不静默）。
 */
function sourcePages(report: QuizBlendReport, questions?: QuizQuestion[] | null): number {
  const urls = new Set<string>();
  for (const q of questions ?? []) {
    if (q.source?.kind === 'collect' && q.source.url) urls.add(q.source.url);
  }
  if (urls.size > 0) return urls.size;
  return report.collect?.pages.filter((p) => p.fetched).length ?? 0;
}

/**
 * 真题合流文案（契约 docs/QUIZ-BLEND-SPEC.md §3.4）：配了真题就得说清「要几道 / 摘到几道 / 缺的为什么没来」。
 * 与 `shortfallText` 同族——判定全在服务端 `report`，本函数只负责说人话，绝不重新判定缺口。
 *
 * ★ 「**未用 AI 顶替**」必须写出来（老板拍板 D3「报缺不补」）：否则用户看到"配了 3 道真题只来 1 道"，
 *   只会当成 bug——而事实是我们**故意**不补（补了「真题」这词就失去意义，且题面上根本分辨不出来）。
 * ★ `questions` 是可选第二参，只为算准「来自 N 个网页」；主路径（对话页出题）手上都有题，应传全。
 *   省略时退回抓取成功页数（上限口径），**不因此返 null**——不静默优先于不精确。
 */
export function blendNote(report?: QuizBlendReport | null, questions?: QuizQuestion[] | null): string | null {
  if (!report) return null;
  const requested = sourceMixTotal(report.real.requested);
  if (requested === 0) return null; // 本次没配真题 → 不是损失，不播报（与 imageNote/searchNote 同口径）

  const actual = sourceMixTotal(report.real.actual);
  // 一条都没摘到：直接交代结果与「谁出的题」，逐页真因由 collect 报告承担（不复述，避免两处说法）
  if (actual === 0) return '真题：本次一道都没摘到（原因见下方逐页报告），题目全部由 AI 出。';

  const parts = MIX_KINDS.filter((t) => report.real.requested[t] > 0).map((t) => {
    const want = report.real.requested[t];
    const got = report.real.actual[t];
    const label = MIX_KIND_LABELS[t];
    return got < want ? `${label} ${got}/${want}（少 ${want - got} 道）` : `${label} ${got}/${want}`;
  });

  if (actual < requested) return `真题：${parts.join('、')}——网上没摘到，未用 AI 顶替。`;

  const pages = sourcePages(report, questions);
  return `真题：${parts.join('、')}（共 ${actual} 道${pages > 0 ? `，来自 ${pages} 个网页` : ''}）。`;
}

