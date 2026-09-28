#!/usr/bin/env node
/**
 * model-bench/freeze-public —— 重新生成仓内那两份公开集**冻结件**(维护命令,不常跑)。
 *
 *   node tools/eval/model-bench/freeze-public.mjs [--per-config 4]
 *
 * 产出两个文件,它们的形态不同,原因只有一个:**许可证**。
 *
 *   datasets/public/frozen-mmlu.jsonl   MMLU 是 MIT ⇒ 题目**正文**可以进本仓(MIT),
 *                                        用途:离线自检与无网冒烟(`--suite public --public-offline`)。
 *   datasets/public/pointers-ceval.json C-Eval 是 CC BY-NC-SA 4.0 ⇒ 正文**不进本仓**
 *                                        (NC 条款与本仓 MIT 冲突,vendored 进来会给下游埋一个看不见的坑)。
 *                                        只存 dataset/config/split/row_idx 与规范化条目的 sha256:
 *                                        仓库不分发受限数据,但「你今天拉到的是不是我当初评的那一条」仍可验证。
 *
 * 这个脚本本身就是那两份文件的**出处说明** —— 冻结件里的每一条都能用它原样重跑出来。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { PUBLIC_DIR, PUBLIC_SOURCES, FROZEN_MMLU, POINTERS_CEVAL, loadPublicItems } from './lib/public-sets.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const perConfig = Number(arg('per-config', '4'));

const { items } = await loadPublicItems({ sources: ['mmlu', 'ceval'], perConfig, refresh: true });
mkdirSync(PUBLIC_DIR, { recursive: true });

const mmlu = items.filter((i) => i.source === 'mmlu');
const ceval = items.filter((i) => i.source === 'ceval');

// ── MIT：正文进仓 ──
const header = {
  _comment: [
    '本文件由 `node tools/eval/model-bench/freeze-public.mjs` 生成，勿手改。',
    `来源 ${PUBLIC_SOURCES.mmlu.dataset}（${PUBLIC_SOURCES.mmlu.homepage}），许可 ${PUBLIC_SOURCES.mmlu.license}。`,
    'MIT 许可允许再分发，故此处存题目正文，供离线自检与无网冒烟使用（--public-offline）。',
    '取样规则：每个 config 取 split 的前 N 条（可复现优先于代表性）——**不要拿这批题的分数去跟公开榜单的全量分比大小**。',
  ].join(' '),
  frozenAt: new Date().toISOString().slice(0, 10),
  count: mmlu.length,
};
writeFileSync(FROZEN_MMLU, [JSON.stringify(header), ...mmlu.map((i) => JSON.stringify(i))].join('\n') + '\n', 'utf8');

// ── NC：只进指纹 ──
writeFileSync(
  POINTERS_CEVAL,
  JSON.stringify(
    {
      _comment: [
        '本文件由 `node tools/eval/model-bench/freeze-public.mjs` 生成，勿手改。',
        `来源 ${PUBLIC_SOURCES.ceval.dataset}（${PUBLIC_SOURCES.ceval.homepage}），许可 ${PUBLIC_SOURCES.ceval.license}。`,
        'CC BY-NC-SA 的 NC 条款与本仓 MIT 冲突，故**只存指针与指纹，不存题目正文**。',
        'sha = sha256({question,options,answer}) 前 16 位；运行时拉到的条目指纹对不上 ⇒ 上游数据集变过，报告会点名。',
      ].join(' '),
      dataset: PUBLIC_SOURCES.ceval.dataset,
      split: PUBLIC_SOURCES.ceval.split,
      license: PUBLIC_SOURCES.ceval.license,
      frozenAt: new Date().toISOString().slice(0, 10),
      items: ceval.map((i) => ({ id: i.id, config: i.config, rowIdx: i.rowIdx, sha: i.sha })),
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

console.log(`frozen-mmlu.jsonl   ${mmlu.length} 条（MIT，含正文）`);
console.log(`pointers-ceval.json ${ceval.length} 条（CC BY-NC-SA，只有指纹）`);
