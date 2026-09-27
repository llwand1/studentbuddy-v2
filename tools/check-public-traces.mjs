#!/usr/bin/env node
/**
 * check-public-traces.mjs —— 公开仓「开发过程痕迹」门禁。
 *
 * 判断标准分两层：
 *   ① **结构层**（写在下面 `FORBIDDEN` 里，随仓分发）：指向已移出公开面的文件、内部编号；
 *   ② **补充层**（可选，不随仓分发）：本机放一份 `.traces.json` 就一并拦，没有就只跑结构层。
 *      为什么分这一层：有些词「写出来才能拦它」——把词表本身放进公开仓，等于又把它公开一次。
 *      所以那份词表留在本机，仓里只留这条通路。
 *
 * 用法：
 *   node tools/check-public-traces.mjs              # 跑两层
 *   node tools/check-public-traces.mjs --selftest   # 证明扫描器真的会红（而不是永远绿）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

/** ① 结构层：随仓分发，公开面必须一直干净 */
export const FORBIDDEN = [
  ['内部编号', /§0\.|§0-\d\d|\bP-0\d|\bMT-\d/],
  ['已移出公开面的引用', /docs\/dev\/|\bAGENTS\.md\b/],
];

/** ② 补充层的落地文件（不随仓分发；见 .gitignore） */
const LOCAL_LIST = '.traces.json';

/**
 * 精确路径豁免（写明理由；理由过期的就删掉）。
 * 本脚本自己的自证用例必须写出几条「该被拦」的形状，那是判据的一部分，不是日记。
 */
const EXEMPT = new Set(['tools/check-public-traces.mjs']);

/** 二进制与图片一类不按文本扫 */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.webm', '.pdf', '.zip',
  '.db', '.sqlite', '.xlsx', '.docx',
]);

/** 读补充层；形状不对就当作没有（不让一份写坏的清单把门禁变成假绿） */
function localGroups() {
  const file = path.join(ROOT, LOCAL_LIST);
  if (!fs.existsSync(file)) return { groups: [], loaded: false };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) return { groups: [], loaded: false };
    const groups = raw
      .filter((row) => Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string')
      .map((row) => [row[0], new RegExp(row[1], 'g')]);
    return { groups, loaded: groups.length > 0 };
  } catch {
    return { groups: [], loaded: false };
  }
}

/** 纯函数：扫一段文本，返回命中的 `分组:词` 列表（同一分组每词只报一次） */
export function scan(text, groups = FORBIDDEN) {
  const hits = [];
  for (const [group, re] of groups) {
    const m = new RegExp(re.source, 'g');
    const seen = new Set();
    for (const found of text.match(m) ?? []) {
      if (seen.has(found)) continue;
      seen.add(found);
      hits.push(`${group}: ${found}`);
    }
  }
  return hits;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function selftest() {
  // 用一份假词表自证判别力：既能红、也能绿，且不用把真词写进本文件
  const fake = [['自证用假词', /假词甲|假词乙/g]];
  const cases = [
    ['干净文本 ⇒ 绿', '这段注释只讲行为与约束。', 0],
    ['命中补充层假词 ⇒ 红', '这句里有假词甲。', 1],
    ['命中结构层 §0.8 ⇒ 红', '按 §0.8 的规定。', 1],
    ['命中结构层 §0-11 ⇒ 红', '见 §0-11 第 4 项。', 1],
    ['命中结构层 docs/dev/ ⇒ 红', '见 docs/dev/test-plan.md。', 1],
    ['命中结构层 P-017 ⇒ 红', '见 P-017 的改动。', 1],
  ];
  let bad = 0;
  let red = 0;
  for (const [name, text, want] of cases) {
    const got = scan(text, want === 1 && text.includes('假词') ? fake : FORBIDDEN).length;
    const ok = got === want;
    if (!ok) bad++;
    if (got > 0) red++;
    console.log(`${ok ? '✓' : '✗'} 自证 ${name} ⇒ 命中 ${got} 项（期望 ${want}）`);
  }
  if (red === 0 || red === cases.length) bad++;
  console.log(`${red > 0 && red < cases.length ? '✓' : '✗'} 自证 结果不是清一色（红 ${red}／共 ${cases.length}）`);
  console.log(bad ? `✗ 自证 ${bad} 条不符` : '✓ 自证全通过');
  process.exit(bad ? 1 : 0);
}

function main() {
  if (process.argv.includes('--selftest')) selftest();

  const { groups: extra, loaded } = localGroups();
  const groups = [...extra, ...FORBIDDEN]; // 补充层在前：它才是真正会命中的那一层
  console.log(
    loaded
      ? `（补充层已载入：${extra.length} 组）`
      : `（未找到补充层 ${LOCAL_LIST} ⇒ 只跑结构层）`,
  );

  const violations = [];
  let scanned = 0;
  for (const rel of trackedFiles()) {
    if (rel === LOCAL_LIST || EXEMPT.has(rel)) continue;
    if (SKIP_EXT.has(path.extname(rel).toLowerCase())) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      continue; // 读不动（权限/损坏）就不是文本，跳过
    }
    if (text.includes('\0')) continue; // 含 NUL ⇒ 二进制
    scanned++;
    const lines = text.split(/\r?\n/);
    const seen = new Set();
    lines.forEach((line, i) => {
      for (const hit of scan(line, groups)) {
        const key = `${rel}|${hit}`;
        if (seen.has(key)) return;
        seen.add(key);
        violations.push(`${rel}:${i + 1}  [${hit}]`);
      }
    });
  }

  if (violations.length) {
    console.error(`✗ 公开仓痕迹 ${violations.length} 处（扫描 ${scanned} 个文本文件）：`);
    for (const v of violations) console.error('  ' + v);
    console.error('\n  这些是开发过程用语，不进公开面：把判断性/过程性从句删掉或改写成客观说明，');
    console.error('  不要替换成同义标签。');
    process.exit(1);
  }
  console.log(`✓ 公开仓痕迹：${scanned} 个文本文件全部干净`);
}

main();
