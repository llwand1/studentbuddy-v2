/**
 * model-bench/lib/public-sets —— 公开学术评测集适配器(MMLU / C-Eval)。
 *
 * ══ 为什么要接公开集 ══
 *
 * 本目录原有的四套件数据集**全是自造的**(`provenance: dev-hand`),README 自己也承认
 * search 套件的资料是「构造的,比真实检索结果更好分」、replicate 那 30 条「网上检索到的原题」
 * 其实是手写的。后果有两条:
 *   ① **没有外部效度** —— 分数只在本仓内部可比,换个人复现不了,也没法跟公开榜单对话;
 *   ② **「答案在学科上是否真对」测不了** —— README 把它列为已知边界,只能交给 `--judge`,
 *      而裁判自己有偏差。公开集自带**金标答案**,这个洞可以用零裁判的方式堵上。
 *
 * ══ 一份数据、两个用途 ══
 *
 *   `public-solve`     —— 模型自己答题,对金标算**正确率**。这直接就是生产 `quiz-verify.ts`
 *                          那道保险丝的能力上限:solver 学科上不行,验算就是在拿坏尺子量。
 *                          也是 PK 对战里 AI 对手的真实水平。
 *   `public-replicate` —— 拿公开集的**真题**当 ref,喂给既有复刻评分器,量协议保真度。
 *                          比手写 ref 更像真实场景(真题有长题干、有 LaTeX、有"以下说法正确的是")。
 *
 * ══ 入仓纪律(许可证是硬约束,不是风格问题)══
 *
 *   MMLU   cais/mmlu        MIT            ⇒ 可以把样本**原文**冻进仓(带出处),供离线自检
 *   C-Eval ceval/ceval-exam CC BY-NC-SA 4.0 ⇒ **不可以**。本仓是 MIT,把 NC 数据 vendored 进来
 *                                             会让下游使用者踩到一个他们看不见的许可冲突。
 *                                             ⇒ 仓内只存**指针**(dataset/config/split/row_idx)
 *                                               与规范化后条目的 sha256,正文运行时按需拉取、
 *                                               落 gitignore 的缓存目录。指纹让「拉到的是不是同一条」
 *                                               可验证,而仓库本身不再分发受限数据。
 *
 * ══ 一条必须写进报告的警告:训练集污染 ══
 *
 *   MMLU/C-Eval 大概率已在被测模型的训练数据里。所以 `public-solve` 的正确率读作
 *   **「这模型记不记得住这些题」的上界**,不是「它在你的新题上有多准」。
 *   这正是同批要做**现场搜题**(`harvest.mjs`)的理由:刚抓下来的题没被背过,
 *   两个数并排看才知道模型是真会还是背过 —— 差值本身就是污染的粗略估计。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = join(HERE, '..', 'datasets', 'public');
export const CACHE_DIR = join(PUBLIC_DIR, 'cache');

const ROWS_API = 'https://datasets-server.huggingface.co/rows';

/** 选项字母 → 下标 */
const LETTER_IDX = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 };

/**
 * 源登记表。
 * `configs` 是**刻意挑过**的:覆盖理/化/生/数/史/计算机,与产品词条库常见领域对齐;
 * 全 57/52 个 config 都跑一遍不是本台的事(那是刷榜,不是回归)。
 */
export const PUBLIC_SOURCES = {
  mmlu: {
    dataset: 'cais/mmlu',
    split: 'test',
    lang: 'en',
    license: 'MIT',
    homepage: 'https://huggingface.co/datasets/cais/mmlu',
    vendorable: true, // MIT ⇒ 样本原文可以冻进仓
    configs: [
      'high_school_physics',
      'high_school_biology',
      'high_school_mathematics',
      'high_school_computer_science',
      'high_school_world_history',
      'college_chemistry',
    ],
    /** row → 统一条目;形状不符返回 null(**跳过并计数**,不造一条假的) */
    normalize(row) {
      const q = typeof row.question === 'string' ? row.question.trim() : '';
      const opts = Array.isArray(row.choices) ? row.choices.map((c) => String(c).trim()) : [];
      const ans = Number(row.answer);
      if (!q || opts.length < 2 || !Number.isInteger(ans) || ans < 0 || ans >= opts.length) return null;
      return { question: q, options: opts, answer: [ans] };
    },
  },
  ceval: {
    dataset: 'ceval/ceval-exam',
    // ★ 必须是 val:C-Eval 的 test 划分**不公开答案**(官方留作榜单评测)。
    //   用 test 会拿到一堆 answer 为空的条目,规范化全部被丢,整轮零样本。
    split: 'val',
    lang: 'zh',
    license: 'CC BY-NC-SA 4.0',
    homepage: 'https://huggingface.co/datasets/ceval/ceval-exam',
    vendorable: false, // NC 条款与本仓 MIT 冲突 ⇒ 仓内只存指针与指纹
    configs: [
      'high_school_physics',
      'high_school_biology',
      'high_school_mathematics',
      'high_school_chemistry',
      'middle_school_history',
      'computer_network',
    ],
    normalize(row) {
      const q = typeof row.question === 'string' ? row.question.trim() : '';
      const opts = ['A', 'B', 'C', 'D'].map((k) => (typeof row[k] === 'string' ? row[k].trim() : ''));
      const idx = LETTER_IDX[String(row.answer ?? '').trim().toUpperCase()];
      if (!q || opts.some((o) => !o) || !Number.isInteger(idx) || idx >= opts.length) return null;
      return { question: q, options: opts, answer: [idx] };
    },
  },
};

/** 规范化条目的指纹:只对**内容**取哈希(不含 fetchedAt 之类会变的字段) */
export function itemSha(item) {
  const canonical = JSON.stringify({ q: item.question, o: item.options, a: item.answer });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function cacheFile(sourceKey, config) {
  const src = PUBLIC_SOURCES[sourceKey];
  return join(CACHE_DIR, `${sourceKey}__${config}__${src.split}.jsonl`);
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function writeJsonl(file, rows) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

/**
 * 拉一个 config 的前 `limit` 条(HF datasets-server,单次上限 100 行)。
 *
 * ★ 为什么是「前 N 条」而不是随机抽样:可复现压倒代表性。同一条命令在任何机器上必须拿到
 *   同一批题,否则两次跑分的差异里就混进了「换了一批题」这个自变量(这正是评测最容易烂掉的方式)。
 *   想换一批就显式给 `offset` —— 换了多少、从哪换的,会写进报告头。
 *   代价照实说:前 N 条不是该科目的随机样本,**不要拿这个数去跟公开榜单的全量分比大小**。
 */
async function fetchConfig(sourceKey, config, limit, offset) {
  const src = PUBLIC_SOURCES[sourceKey];
  const out = [];
  let dropped = 0;
  let got = 0;
  while (out.length < limit && got < limit * 3) {
    const length = Math.min(100, limit - out.length + dropped);
    const url =
      `${ROWS_API}?dataset=${encodeURIComponent(src.dataset)}&config=${encodeURIComponent(config)}` +
      `&split=${encodeURIComponent(src.split)}&offset=${offset + got}&length=${length}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HF rows API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length === 0) break;
    got += rows.length;
    for (const r of rows) {
      if (out.length >= limit) break;
      const norm = src.normalize(r.row ?? {});
      if (!norm) {
        dropped += 1;
        continue;
      }
      out.push({
        id: `${sourceKey}/${config}/${src.split}/${r.row_idx}`,
        source: sourceKey,
        dataset: src.dataset,
        config,
        split: src.split,
        rowIdx: r.row_idx,
        lang: src.lang,
        domain: config,
        license: src.license,
        homepage: src.homepage,
        ...norm,
        sha: '',
      });
    }
  }
  for (const it of out) it.sha = itemSha(it);
  return { items: out, dropped };
}

/**
 * 取公开集条目。
 *
 * @param {object} opts
 *   sources    ['mmlu','ceval']
 *   perConfig  每个 config 取几条
 *   offset     从第几条起(默认 0,换切片用)
 *   offline    true ⇒ 只读缓存/冻结件,一个网络请求都不发(CI 与无网环境)
 *   refresh    true ⇒ 忽略缓存重拉
 * @returns {{ items: any[], report: object }}
 */
export async function loadPublicItems(opts = {}) {
  const sources = opts.sources ?? ['mmlu', 'ceval'];
  const perConfig = opts.perConfig ?? 5;
  const offset = opts.offset ?? 0;
  const report = { sources: {}, offline: !!opts.offline, offset, perConfig };
  const items = [];

  // 离线兜底:MIT 冻结件(仓内有正文)。C-Eval 没有这一档 —— NC 许可下本仓不分发正文,
  // 所以「离线 + 无缓存」时 ceval 只能是 0 条,报告里必须说出这个理由而不是静默少一半样本。
  //
  // ★ 键必须是 `source/config` 而**不是** config —— MMLU 与 C-Eval 有同名 config
  //   (high_school_physics / high_school_biology / high_school_mathematics 三个撞名)。
  //   只按 config 查表的后果:离线档下 C-Eval 会被喂进 MMLU 的英文题,却仍挂着 ceval 的 id 与许可
  //   ——一个「有数、但是错的数」。这条是本批离线冒烟当场测出来的,不是推想。
  const frozenByKey = new Map();
  if (opts.offline && sources.includes('mmlu') && existsSync(FROZEN_MMLU)) {
    for (const it of loadFrozenMmlu()) {
      const k = `${it.source}/${it.config}`;
      const list = frozenByKey.get(k) ?? [];
      list.push(it);
      frozenByKey.set(k, list);
    }
  }

  for (const key of sources) {
    const src = PUBLIC_SOURCES[key];
    if (!src) throw new Error(`未知公开集 ${key}(可选:${Object.keys(PUBLIC_SOURCES).join(', ')})`);
    const per = { license: src.license, homepage: src.homepage, got: 0, dropped: 0, fromCache: 0, fromFrozen: 0, fetched: 0, configs: {}, notes: [] };
    for (const config of src.configs) {
      const file = cacheFile(key, config);
      let cached = readJsonl(file);
      let used;
      if (opts.offline && cached.length < offset + perConfig) {
        // 缓存不够:MIT 的走仓内冻结件,NC 的照实记 0 并说明原因
        used = (frozenByKey.get(`${key}/${config}`) ?? []).slice(offset, offset + perConfig);
        per.fromFrozen += used.length;
        if (used.length === 0 && !src.vendorable)
          per.notes.push(`${config}: 离线且无缓存 —— ${src.license} 不允许本仓内置正文，请先联网跑一次 --refresh`);
      } else if (opts.offline || (cached.length >= offset + perConfig && !opts.refresh)) {
        used = cached.slice(offset, offset + perConfig);
        per.fromCache += used.length;
      } else {
        const { items: fresh, dropped } = await fetchConfig(key, config, offset + perConfig, 0);
        per.dropped += dropped;
        writeJsonl(file, fresh);
        cached = fresh;
        used = fresh.slice(offset, offset + perConfig);
        per.fetched += used.length;
      }
      per.configs[config] = used.length;
      per.got += used.length;
      items.push(...used);
    }
    report.sources[key] = per;
  }

  if (items.length === 0) {
    throw new Error(
      opts.offline
        ? '离线模式下没有可用的公开集缓存 —— 先联网跑一次 `npm run eval:public -- --refresh`,或用 --frozen 读仓内冻结件'
        : '公开集一条都没取到(网络或上游形状变了)',
    );
  }
  return { items, report };
}

// ─────────────────────── 仓内冻结件(自检与离线冒烟用) ───────────────────────

export const FROZEN_MMLU = join(PUBLIC_DIR, 'frozen-mmlu.jsonl');
export const POINTERS_CEVAL = join(PUBLIC_DIR, 'pointers-ceval.json');

/**
 * 读 MIT 冻结件(正文在仓里,可离线)。
 * 首行是出处说明(`_comment`),不是条目 —— 过滤掉它,否则会多出一条没有 question 的假样本。
 */
export function loadFrozenMmlu() {
  const rows = readJsonl(FROZEN_MMLU).filter((r) => r && typeof r.question === 'string');
  if (rows.length === 0) throw new Error(`冻结件为空或只有出处说明:${FROZEN_MMLU}`);
  return rows;
}

/**
 * 校验 C-Eval 指针:拉下来的条目指纹必须与仓内记的一致。
 *
 * 这是 NC 数据「不入仓但可验证」的那一半 —— 仓里没有正文,却能回答
 * 「你今天拉到的 ceval/high_school_physics/val/0 跟我当初评测用的是不是同一条」。
 * 上游改了数据集(重新划分、修题面)⇒ 指纹对不上 ⇒ 报告里必须看得见,
 * 而不是让分数悄悄地在另一批题上变动。
 */
export function verifyCevalPointers(items) {
  if (!existsSync(POINTERS_CEVAL)) return { checked: 0, matched: 0, mismatched: [], missing: 0 };
  const pointers = JSON.parse(readFileSync(POINTERS_CEVAL, 'utf8'));
  const want = new Map((pointers.items ?? []).map((p) => [p.id, p.sha]));
  const out = { checked: 0, matched: 0, mismatched: [], missing: 0 };
  for (const it of items) {
    if (it.source !== 'ceval') continue;
    const expect = want.get(it.id);
    if (!expect) {
      out.missing += 1;
      continue;
    }
    out.checked += 1;
    if (expect === it.sha) out.matched += 1;
    else out.mismatched.push({ id: it.id, expect, got: it.sha });
  }
  return out;
}

// ─────────────────────── 两个用途的用例转换 ───────────────────────

/** 公开条目 → 盲解用例 */
export function toSolveCase(item) {
  return {
    id: item.id,
    domain: item.domain,
    lang: item.lang,
    source: item.source,
    question: item.question,
    options: item.options,
    answer: item.answer,
    multiple: item.answer.length > 1,
  };
}

/** 公开条目 → 复刻用例(直接喂既有 `replicateSuite`,一行评分器都不用改) */
export function toReplicateCase(item) {
  return {
    id: item.id,
    domain: item.domain,
    lang: item.lang,
    source: item.source,
    type: item.answer.length > 1 ? 'multiple' : 'single',
    ref: { question: item.question, options: item.options, answer: item.answer },
  };
}
