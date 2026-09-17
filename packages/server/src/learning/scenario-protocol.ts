/**
 * learning/scenario-protocol — 情景题出题协议与解析（契约 docs/SCENARIO-SPEC.md §6，v1.1 M2）。
 *
 * 协议是**双标记**而非单个 JSON：`[SCENARIO]` 包评分点 JSON，`[SCENARIO_HTML]` 包**裸 HTML**。
 * 刻意不把 demo 塞进 JSON 字符串字段——整页 HTML 里的引号转义是传统题 svg 字段翻车的同款坑
 * （见 quiz.ts SVG_FIELD 的历史），且体量大一个数量级；裸标记让模型零转义输出，失败面砍掉一大半。
 *
 * 解析阶梯（代价从低到高，与 parseQuizBlock 同哲学）：
 * ① 原样：成对标记 + 合法 JSON 直接过；
 * ② 无损修复：漏转义 / 漏 `]`（复用 quiz-json-repair，两条在合法输入上永不触发）；
 * ③ JSON 截断逐题回退：撞 max_tokens 总是最后一个 task 残缺，线性深度扫描砍尾补 `]}`；
 * ④ HTML 截断抢救：没有闭合标记就吃到结尾，能在 `</html>` 收口就收口——
 *    demo 尾巴残缺时引用完整性检查会把接不上的评分点丢掉，宁可少几个评分点不整组报废。
 * 全部线性扫描，正则回溯钉死线程的事故不许重演（quiz.ts SVG_FIELD 注释）。
 */
import type { ScenarioPayload, ScenarioTask } from '@sb/shared';
import { MAX_SCENARIO_HTML_CHARS, normalizeScenarioPayload } from '@sb/shared';
import { repairJsonBrackets, repairJsonEscapes } from './quiz-json-repair.js';

/**
 * 出题协议提示词。要点全部钉死在示例里：
 * - 双标记各包什么（HTML **不进** JSON，零转义）；
 * - 每个评分点必须在 demo 里调 `SBScenario.report(taskId, observed)`，observed 的形状按判型给；
 * - demo 自包含、无外链（CSP sandbox 加载不了外链，写了也白写）；
 * - 对错不归 demo 判（服务端判，契约 §0.2），demo 只管把事实报上来。
 */
export const SCENARIO_PROTOCOL = `你是一个情景题出题引擎。根据给定材料出一道"情景题"：一个可交互的网页小 demo，用户在里面动手操作，系统按评分点判分。严格按以下两段标记输出。

第一段：评分点清单（JSON，描述判分标准）：
[SCENARIO]{"title":"情景标题","tasks":[{"id":"t1","prompt":"任务描述（做什么）","criteria":{"kind":"choice","answer":[2]},"hint":"可选提示"},{"id":"t2","prompt":"任务描述","criteria":{"kind":"state","value":"open"}},{"id":"t3","prompt":"任务描述","criteria":{"kind":"order","answer":["先接地","后接火"]}}]}[/SCENARIO]

第二段：demo 网页源码（完整 HTML 文档，原样放在标记之间，不要放在 JSON 里、不要任何转义）：
[SCENARIO_HTML]<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>...</style></head><body>
<!-- 交互界面：按钮/下拉/拖拽等 -->
<script>
// 用户完成某步操作时，上报事实（不是对错！对错由服务端判）：
// 选择题：  SBScenario.report('t1', [选中的选项下标数组])
// 状态题：  SBScenario.report('t2', '状态值')
// 排序题：  SBScenario.report('t3', ['排好序的字符串数组'])
</script></body></html>[/SCENARIO_HTML]

规则：
1. criteria 三种判型：choice 的 answer 是正确选项下标数组；state 的 value 是目标状态值；order 的 answer 是正确顺序的字符串数组。
2. demo 里必须给出让用户完成每个任务的操作方式，并在恰当时机调用 SBScenario.report('该任务id', 该形状的事实)。每个任务的 id 必须原样出现在 HTML 里（脚本调用中）。
3. demo 完全自包含：CSS/JS 全部内联，不引用任何外部资源（外链在沙箱里加载不了）。界面要简洁可玩，操作步骤在页面上写清楚。
4. 评分点 3～6 个，必须源于给定材料，不得编造。
5. [SCENARIO_HTML] 标记之间只放 HTML 源码本身，除两对标记外不要输出任何其他文字。`;

/** 生成过程报告（ADR-5 三态反馈：丢了几条、有没有抢救，如实报不静默） */
export interface ScenarioGenReport {
  /** 输出被截断过（JSON 或 HTML 走了抢救阶梯，或适配器 finishReason=length） */
  truncated: boolean;
  /** HTML 没写闭合标记、按「吃到结尾」抢救成功 */
  htmlRescued: boolean;
  /** 被丢弃的评分点数（normalize 丢弃 + 引用完整性丢弃） */
  droppedTasks: number;
  /** demo 超长被整组拒收（MAX_SCENARIO_HTML_CHARS） */
  htmlOversized: boolean;
  /** 失败真因：no-model=没配出题模型；parse=输出解不成情景题 */
  failure?: 'no-model' | 'parse';
}

export function emptyScenarioGenReport(): ScenarioGenReport {
  return { truncated: false, htmlRescued: false, droppedTasks: 0, htmlOversized: false };
}

/**
 * JSON 截断逐题回退：从「tasks 数组里刚闭合完一个完整 task 对象」处砍尾补 `]}`。
 * 结构深度：顶层 { =1 → tasks 的 [ =2 → task 的 { =3；弹出后深度回到 2 且闭合符是 `}`
 * 即刚收尾一个完整 task。线性单遍，无正则。
 */
function salvageTruncatedScenarioJson(json: string): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let cut = -1;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i] ?? '';
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 2 && ch === '}') cut = i + 1;
    }
  }
  return cut < 0 ? null : `${json.slice(0, cut)}]}`;
}

/** 超过这个长度不再抢救（与 quiz.ts MAX_RESCUE_CHARS 同档） */
const MAX_RESCUE_CHARS = 500_000;

/** HTML 截断收口：有 `</html>` 收到它；没有就收到最后一个 `>`（残缺标签尾巴砍掉） */
function salvageTruncatedHtml(html: string): string {
  const close = html.toLowerCase().lastIndexOf('</html>');
  if (close >= 0) return html.slice(0, close + '</html>'.length);
  const lastGt = html.lastIndexOf('>');
  return lastGt >= 0 ? html.slice(0, lastGt + 1) : html;
}

/**
 * 解析模型输出中的情景题双标记（容错阶梯见文件头）。
 * 返回 null 表示整组报废（没有 demo / JSON 完全不成套 / demo 超限）；
 * 成功时 payload 已过 normalize，html 已过引用完整性检查。
 */
export function parseScenarioBlock(
  text: string,
  report?: ScenarioGenReport,
): { payload: ScenarioPayload; html: string } | null {
  if (!text) return null;
  // ── HTML 段：有开标记就吃（没闭合标记＝截断，抢救并如实报）──
  const htmlStart = text.indexOf('[SCENARIO_HTML]');
  let html: string | null = null;
  if (htmlStart >= 0) {
    const body = text.slice(htmlStart + '[SCENARIO_HTML]'.length);
    const closed = body.indexOf('[/SCENARIO_HTML]');
    const raw = closed >= 0 ? body.slice(0, closed) : body;
    if (report) report.htmlRescued = closed < 0;
    html = closed < 0 ? salvageTruncatedHtml(raw) : raw;
  }
  if (!html || !html.trim()) return null;
  // 硬限制在一切检查之前：demo 超限整组拒收，别让它白耗一遍解析（saveScenario 同一道闸，这里提前给真因）
  if (html.length > MAX_SCENARIO_HTML_CHARS) {
    if (report) report.htmlOversized = true;
    return null;
  }

  // ── JSON 段：成对标记 → 截断回退 → 全文兜底（兼容模型忘写 [SCENARIO] 只给 JSON）──
  const m = text.match(/\[SCENARIO\]([\s\S]*?)\[\/SCENARIO\]/);
  let rawJson = m ? m[1] : '';
  if (!rawJson && htmlStart >= 0) rawJson = text.slice(0, htmlStart);
  else if (!rawJson) rawJson = text;
  const cleaned = rawJson.replace(/```json|```/g, '').trim();
  if (!cleaned.includes('"tasks"')) return null;
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  // 候选阶梯：正常抽取 → 截断抢救（只在截断时才有残缺尾巴可砍）
  const base = objMatch ? repairJsonBrackets(repairJsonEscapes(objMatch[0]).text).text : null;
  const candidates: string[] = [];
  if (base) candidates.push(base);
  if (cleaned.length <= MAX_RESCUE_CHARS) {
    const salvageSrc = base ?? repairJsonBrackets(repairJsonEscapes(cleaned).text).text;
    const salvaged = salvageTruncatedScenarioJson(salvageSrc);
    if (salvaged) candidates.push(salvaged);
  }
  let payload: ScenarioPayload | null = null;
  let rawTaskCount = 0;
  let salvagedOk = false; // 命中的是不是抢救候选——truncated 如实报的依据（report.truncated 不能只看 htmlRescued）
  for (const [body, wasSalvaged] of candidates.map((b, i) => [b, i > 0 || (base === null && i === 0)] as const)) {
    try {
      const obj = JSON.parse(body) as Record<string, unknown>;
      const tasks = obj.tasks;
      rawTaskCount = Array.isArray(tasks) ? tasks.length : 0;
      payload = normalizeScenarioPayload(obj);
    } catch {
      continue;
    }
    if (payload) {
      salvagedOk = wasSalvaged;
      break;
    }
  }
  if (!payload) return null;
  if (report) {
    report.truncated = report.truncated || salvagedOk || report.htmlRescued || !objMatch;
    report.droppedTasks += Math.max(0, rawTaskCount - payload.tasks.length);
  }

  // ── 引用完整性：id 没在 demo HTML 里出现的评分点永远等不到回传，整条丢弃（契约 §6.3）──
  const kept = payload.tasks.filter((t: ScenarioTask) => html.includes(t.id));
  if (report) report.droppedTasks += payload.tasks.length - kept.length;
  if (kept.length === 0) return null;
  return { payload: { ...payload, tasks: kept }, html };
}
