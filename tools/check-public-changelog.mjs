#!/usr/bin/env node
/**
 * check-public-changelog.mjs — 断言「对外公开更新表」跟得上**已经发出去**的版本。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 线上那页公开更新记录（含 Atom 订阅）的内容是一份**手写的对外清洗表**
 * （`packages/web/src/seo/changelog-public.ts` 的 `PUBLIC_RELEASES`），每次发版要人工补一行。
 * 而补这一行**没有任何机器拦着**：既有的锁只防「把还没上线的版本写进去」，
 * 不防「上线了却忘了写」——后者正是这一页存在的意义被悄悄掏空的那一侧。
 *
 * 所以判据钉在 **tag** 上，不钉在「内部变更记录的最高拟号」上：tag 是
 * 「这一版真的被构建并推上线了」的唯一机械证据（对外表按规矩只写已生效的改动）。
 * ⇒ 于是 `最高已发版 tag ≠ 表头` 只可能是两种事：发完版没补表，或表里写了没发出去的东西。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node tools/check-public-changelog.mjs              # 发版脚本第 ①c 步（不一致 ⇒ 退出码 2）
 *   SKIP_PUBLIC_CHANGELOG_CHECK=1 bash tools/deploy.sh # 显式跳过（要写明为什么才许按）
 *   node tools/check-public-changelog.mjs --selftest   # 证明这把守门真的会红
 *
 * ★ 零依赖、只读、不碰网络（一次 `git tag` ＋ 两个仓内文件）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const TABLE = 'packages/web/src/seo/changelog-public.ts';
const LEDGER = 'CHANGELOG.md';
const VERSION_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

function parse(v) {
  const m = VERSION_RE.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * 返回 -1 / 0 / 1。★ 解析不了的形状按「最小」算 ⇒ 它绝不会和任何真版本号判成相等，
 * 于是「拿错字符串来比」这种错会表现为一条红，而不是一条假绿。
 */
function cmp(a, b) {
  const pa = parse(a) ?? [-1, -1, -1];
  const pb = parse(b) ?? [-1, -1, -1];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** 纯函数：判据本体，`--selftest` 直接喂假数据证明它两侧都会红 */
export function judge(tagged, table) {
  const c = cmp(tagged, table);
  if (c === 0) return { ok: true, verdict: 'sync' };
  return { ok: false, verdict: c > 0 ? 'table-lags' : 'table-ahead' };
}

/** 已合并进当前历史的最高版本 tag（`--merged` 是关键：旁支上挂着的 tag 不算发过版） */
function highestMergedTag() {
  let out;
  try {
    out = execFileSync('git', ['tag', '--merged', 'HEAD', '--sort=-v:refname'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch {
    return { tags: [], error: 'git tag 跑不动（这里不是 git 仓库？）' };
  }
  const tags = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => VERSION_RE.test(s));
  return { tags, error: null };
}

/** 表头＝`PUBLIC_RELEASES` 的第一条 `version`（那页新到旧排列，顺序另有测试锁着） */
function tableHead() {
  const src = fs.readFileSync(path.join(ROOT, TABLE), 'utf8');
  const i = src.indexOf('PUBLIC_RELEASES');
  if (i < 0) return { head: null, error: `${TABLE} 里找不到 PUBLIC_RELEASES` };
  const m = /version:\s*'(v[\d.]+)'/.exec(src.slice(i));
  if (!m) return { head: null, error: `${TABLE} 里 PUBLIC_RELEASES 的第一条没有 version` };
  return { head: m[1], error: null };
}

/**
 * 内部变更记录「未发布」段里领先于表头的 `拟 vX.Y.Z`。
 * ★ 它**不是**判据（拟号要等合批发版才定），只在闸门已经绿的时候提醒一句「这次要补几行」。
 */
function pendingDraftVersions(table) {
  const src = fs.readFileSync(path.join(ROOT, LEDGER), 'utf8');
  const from = src.indexOf('## 未发布');
  if (from < 0) return [];
  const rest = src.slice(from + '## 未发布'.length);
  const to = rest.search(/^## /m);
  const section = to < 0 ? rest : rest.slice(0, to);
  const seen = new Set();
  for (const m of section.matchAll(/拟\s*(v[\d.]+)/g)) if (parse(m[1])) seen.add(m[1]);
  return [...seen].filter((v) => cmp(v, table) > 0).sort(cmp);
}

function selftest() {
  const cases = [
    { name: '同版本 ⇒ 绿', got: judge('v0.2.125', 'v0.2.125'), want: 'sync,true' },
    { name: 'tag 领先 ⇒ 红（发版没补表＝本闸门的正身）', got: judge('v0.2.126', 'v0.2.125'), want: 'table-lags,false' },
    { name: '表领先 ⇒ 红（对外页不许写没上线的版本）', got: judge('v0.2.125', 'v0.2.126'), want: 'table-ahead,false' },
    { name: '比数值不比字符串（v0.2.10 必须领先 v0.2.9）', got: judge('v0.2.10', 'v0.2.9'), want: 'table-lags,false' },
    { name: '解析不了的形状不许判成相等（宁可红也不假绿）', got: judge('main', 'v0.2.125'), want: 'table-ahead,false' },
  ];
  let bad = 0;
  for (const c of cases) {
    const got = `${c.got.verdict},${c.got.ok}`;
    const ok = got === c.want;
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} 自证 ${c.name} ⇒ ${got}（期望 ${c.want}）`);
  }
  // ★ 自证也要自证：上面五条里必须有红有绿，全绿说明这条条都在通过＝判据根本没在判
  const greens = cases.filter((c) => c.got.ok).length;
  if (greens === 0 || greens === cases.length) bad++;
  console.log(`${greens > 0 && greens < cases.length ? '✓' : '✗'} 自证 结果不是清一色（绿 ${greens}／共 ${cases.length}）`);
  console.log(bad ? `✗ 自证 ${bad} 条不符` : '✓ 自证全通过');
  process.exit(bad ? 1 : 0);
}

function main() {
  if (process.argv.includes('--selftest')) selftest();

  const { head, error: tableErr } = tableHead();
  if (tableErr) {
    console.log(`✗ 读不到对外更新表的表头：${tableErr}`);
    process.exit(2);
  }
  const { tags, error: tagErr } = highestMergedTag();
  if (tagErr) {
    console.log(`⚠️  无从对账（${tagErr}）⇒ 本闸门不拦，但请注意这一条**没有**被验证过。`);
    process.exit(0);
  }
  if (tags.length === 0) {
    console.log('⚠️  当前历史里没有任何版本 tag ⇒ 无从判断「发过哪些版」，本闸门不拦。');
    console.log(`    对外表头＝${head}（未经对账）`);
    process.exit(0);
  }

  const top = tags[0];
  const r = judge(top, head);
  const skip = process.env.SKIP_PUBLIC_CHANGELOG_CHECK === '1';

  if (r.ok) {
    console.log(`✓ 对外更新表表头＝最高已发版 tag＝${head}`);
    const pending = pendingDraftVersions(head);
    if (pending.length) {
      console.log(
        `   ⚠️ 内部变更记录「未发布」段里有 ${pending.length} 个拟号领先于它（${pending.join(' / ')}）——` +
          '其中每一个都要在本次发版时清洗成对外表里的一行，否则下一次跑这里就会红。',
      );
    }
    process.exit(0);
  }

  const behind = tags.filter((t) => cmp(t, head) > 0);
  console.log('✗ 对外公开更新表与「已发版的最高 tag」不一致：');
  console.log(`    已发版（tag，且已合并进当前历史）最高＝${top}`);
  console.log(`    对外表 PUBLIC_RELEASES 表头＝${head}`);
  console.log('');
  if (r.verdict === 'table-lags') {
    console.log(`  ⇒ 表落后 ${behind.length} 个版本：${behind.join(' / ')}`);
    console.log('    线上那页更新记录此刻正**落后于线上本身**——这正是它存在的意义被掏空的样子。');
    console.log(`    补法：在 ${TABLE} 的数组最前面按新到旧各补一条（version/date/headline/items），`);
    console.log('    文案按那一页的对外口径写（用户能感知到什么），内部动因与施工编号不进那页。');
    console.log('    补完 `npx vitest run packages/web/src/seo/changelog.test.ts` 验一遍形状锁，再回来发版。');
  } else {
    console.log('  ⇒ 表领先于已发版的 tag：对外页写着「还没生效的改动」。');
    console.log('    两种可能，按顺序排：① 这一版还没发出去 ⇒ 那就先别写进对外表；');
    console.log('    ② 已经发了但漏打 tag ⇒ 那是发版流程漏了第三步，先补 tag 再来对账。');
  }
  console.log('');
  console.log('  确知要带着这个不一致上线时才许跳过：SKIP_PUBLIC_CHANGELOG_CHECK=1（跳过要在变更记录里写明为什么）。');
  if (skip) {
    console.log('⚠️  SKIP_PUBLIC_CHANGELOG_CHECK=1 ⇒ 上面这条不一致已被显式跳过，发版继续。');
    process.exit(0);
  }
  process.exit(2);
}

main();
