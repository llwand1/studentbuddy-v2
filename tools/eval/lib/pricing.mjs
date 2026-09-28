/**
 * tools/eval/lib/pricing —— 价表装载与成本换算（**两套评测台共用的唯一一份**）。
 *
 * 为什么单独一个零依赖 .mjs 放在 `tools/eval/lib/`：
 *   `tools/eval/`（评测台，.mts + tsx）与 `tools/eval/model-bench/`（横评台，纯 .mjs）
 *   都要报成本。口径双写迟早漂移（`doc-rag.ts` 常量双写、`ebbinghaus.ts` 判定双写都是前科），
 *   所以价表与换算只有这一份，两边 import 同一个文件。.mjs 是最小公分母：tsx 能吃，node 也能吃。
 *
 * 三条纪律（都是「不知道」与「零」不许混为一谈的同一条原则）：
 *   ① 查不到价 ⇒ 成本 `null`，渲染成 `—（价表无此模型）`，**绝不 0**；
 *   ② 价表条目过期（asOf 超 staleAfterDays）⇒ 照算但打 `stale` 标，报告里必须看得见；
 *   ③ 条目缺 source/asOf ⇒ 加载即抛。一条没有出处的价格，比没有价格更危险。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TABLE_FILE = join(HERE, '..', 'pricing.json');

const DAY_MS = 24 * 60 * 60 * 1000;

/** @typedef {{ match: string, in: number, out: number, asOf: string, source: string }} PriceRow */
/** @typedef {{ version: string, currency: string, staleAfterDays: number, models: PriceRow[] }} PriceTable */

/** @type {PriceTable | null} */
let cached = null;

/** 读价表（带校验）。缺 source/asOf 的条目直接抛——见头注纪律 ③。 */
export function loadPriceTable() {
  if (cached) return cached;
  /** @type {PriceTable} */
  const table = JSON.parse(readFileSync(TABLE_FILE, 'utf8'));
  if (!Array.isArray(table.models)) throw new Error(`价表结构不对（缺 models 数组）：${TABLE_FILE}`);
  for (const row of table.models) {
    if (!row.match || typeof row.in !== 'number' || typeof row.out !== 'number')
      throw new Error(`价表条目缺 match/in/out：${JSON.stringify(row)}`);
    if (!row.source || !row.asOf)
      throw new Error(`价表条目「${row.match}」缺 source 或 asOf —— 没有出处的价格不许进表（pricing.json 的 discipline 第 2 条）`);
    if (Number.isNaN(Date.parse(row.asOf))) throw new Error(`价表条目「${row.match}」的 asOf 不是日期：${row.asOf}`);
  }
  cached = table;
  return table;
}

/** 模型名归一：小写、去掉网关常见的 `vendor/` 前缀与 `:free` 之类后缀 */
function normalizeModel(model) {
  return String(model ?? '')
    .toLowerCase()
    .replace(/^[\w.-]+\//, '')
    .replace(/[:@][\w.-]+$/, '')
    .trim();
}

/**
 * 查某个模型的价。
 *
 * 匹配顺序：env 覆盖 > 精确相等 > **最长前缀**。
 * 最长前缀是为了吃下 `gpt-4o-mini-2024-07-18` 这类带日期后缀的模型名，
 * 而「最长」是为了让 `gpt-4.1-mini` 不被更短的 `gpt-4.1` 抢走（表里两条都在）。
 *
 * @returns {{ in:number, out:number, source:string, asOf:string, via:'env'|'exact'|'prefix', stale:boolean } | null}
 */
export function priceFor(model, now = Date.now()) {
  const envIn = Number(process.env.EVAL_PRICE_IN);
  const envOut = Number(process.env.EVAL_PRICE_OUT);
  if (Number.isFinite(envIn) && Number.isFinite(envOut)) {
    return {
      in: envIn,
      out: envOut,
      source: process.env.EVAL_PRICE_NOTE || 'env: EVAL_PRICE_IN / EVAL_PRICE_OUT',
      asOf: new Date(now).toISOString().slice(0, 10),
      via: 'env',
      stale: false,
    };
  }
  const table = loadPriceTable();
  const key = normalizeModel(model);
  if (!key) return null;
  const staleAfter = (table.staleAfterDays ?? 120) * DAY_MS;
  const mark = (row, via) => ({
    in: row.in,
    out: row.out,
    source: row.source,
    asOf: row.asOf,
    via,
    stale: now - Date.parse(row.asOf) > staleAfter,
  });

  const exact = table.models.find((r) => normalizeModel(r.match) === key);
  if (exact) return mark(exact, 'exact');

  let best = null;
  for (const row of table.models) {
    const m = normalizeModel(row.match);
    if (key.startsWith(m) && (best == null || m.length > normalizeModel(best.match).length)) best = row;
  }
  return best ? mark(best, 'prefix') : null;
}

/**
 * 算一次调用的成本（美元）。
 * token 数拿不到（provider 不回 usage 且没开估算）⇒ 返回 null，不猜。
 *
 * @param {{ promptTokens: number|null, completionTokens: number|null }} usage
 * @returns {{ usd: number, price: ReturnType<typeof priceFor> } | null}
 */
export function costOf(model, usage, now = Date.now()) {
  const price = priceFor(model, now);
  if (!price) return null;
  const pt = usage?.promptTokens;
  const ct = usage?.completionTokens;
  if (!Number.isFinite(pt) || !Number.isFinite(ct)) return null;
  return { usd: (pt / 1e6) * price.in + (ct / 1e6) * price.out, price };
}

/** 美元金额的显示：小额不许被四舍五入成 $0.00（那会读成「免费」） */
export function fmtUsd(usd) {
  if (usd == null || !Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

/** 价表来源的一行说明，进报告头（读的人要能自己去核这几个数） */
export function priceProvenance(model) {
  const p = priceFor(model);
  if (!p) return `价表无 \`${model}\` —— 本轮成本记 —（不是 0）`;
  const stale = p.stale ? '　⚠ **价表过期**，该数只作量级参考' : '';
  return `价 in $${p.in}／out $${p.out} 每 1M token（匹配方式 ${p.via}，抄于 ${p.asOf}，出处 ${p.source}）${stale}`;
}
