#!/usr/bin/env node
/**
 * check-version.mjs — 断言「全仓只有一个版本号」。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 2026-09-30 之前本仓并存两套号：`package.json` / `/api/status` 报产品内部号 `2.0.0-alpha.0`，
 * tag / Release / CHANGELOG / 对外更新页 / README 徽章报部署构建号 `v0.2.x`。两套号各自都有道理，
 * 合在一起就是「用户从 /api/status 看到的版本对不上更新页」，README 只好写一段话教人别信 /api/status。
 * 现在统一成一个：**版本号 = 部署构建号**，事实源链条是
 *
 *   根 package.json ＝ 三个 workspace 的 package.json（本脚本）
 *     ＝ 服务端运行时读 package.json 报给 /api/status（`packages/server/src/version.ts`）
 *     ＝ 最高已合并 tag `vX.Y.Z`（本脚本；发版前一刻允许 package.json 领先 tag 一步）
 *     ＝ CHANGELOG.md 最高的 `## vX.Y.Z` 标题（本脚本）
 *     ＝ `PUBLIC_RELEASES[0]`（`check-public-changelog.mjs` 对 tag 核）
 *     ＝ README 徽章 `version-X.Y.Z`（`metrics.mjs --check` 对 package.json 核）
 *
 * 判断标准写成纯函数 `judge()`，`--selftest` 直接喂假数据证明每条规则真的会红。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node tools/check-version.mjs              # npm run gates 的一环（不一致 ⇒ 退出码 1）
 *   node tools/check-version.mjs --selftest   # 证明这把守门真的会红
 *
 * ★ 零依赖、只读（几个仓内文件 ＋ 一次 `git tag`）。CI 浅克隆没有 tag 时，tag 那条按「无法核对」跳过并说明。
 * ★ 只认形如 `vX.Y.Z` 的 tag：桌面安装包的 `desktop-vX.Y.Z`（GITHUB-OPS-SPEC R-3）是另一条产品线的号，**刻意不参与**本核对。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PKGS = ['package.json', 'packages/shared/package.json', 'packages/server/package.json', 'packages/web/package.json'];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function parse(v) {
  const m = SEMVER.exec(String(v ?? '').trim().replace(/^v/, ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 / 0 / 1；解析不了的按最小算 ⇒ 绝不会与真版本号判成相等（宁可红不假绿）。 */
function cmp(a, b) {
  const pa = parse(a) ?? [-1, -1, -1];
  const pb = parse(b) ?? [-1, -1, -1];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/**
 * 判断标准本体（纯函数）。
 * @param {{ pkgs: Record<string,string>, changelogTop: string|null, highestTag: string|null, headTags: string[] }} facts
 * @returns {{ ok: boolean, problems: string[], notes: string[] }}
 */
export function judge(facts) {
  const problems = [];
  const notes = [];
  const root = facts.pkgs['package.json'];
  if (!parse(root)) problems.push(`根 package.json 的 version「${root}」不是 X.Y.Z（一个号就是部署构建号，不带 -alpha 之类后缀）`);
  for (const [file, v] of Object.entries(facts.pkgs)) {
    if (file !== 'package.json' && v !== root) problems.push(`${file} 的 version「${v}」≠ 根「${root}」（用 npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version 一次改齐）`);
  }
  if (facts.changelogTop === null) problems.push('CHANGELOG.md 里找不到任何 `## vX.Y.Z` 标题');
  else if (cmp(facts.changelogTop, root) !== 0) problems.push(`CHANGELOG.md 最高版本标题「${facts.changelogTop}」≠ package.json「${root}」（发版四件套：改号与记录行同一提交）`);
  if (facts.highestTag === null) notes.push('本地没有 v* tag（浅克隆 / 未 fetch tags）⇒ tag 一致性未核对');
  else {
    const c = cmp(root, facts.highestTag);
    if (c < 0) problems.push(`最高已合并 tag「${facts.highestTag}」领先 package.json「${root}」——打了 tag 没改号（tag 应挂在改号那个提交上）`);
    else if (c > 0) notes.push(`package.json「${root}」领先最高 tag「${facts.highestTag}」：发版前一刻的正常状态，打 tag 后归零`);
  }
  for (const t of facts.headTags) {
    if (cmp(t, root) !== 0) problems.push(`HEAD 挂着 tag「${t}」但 package.json 是「${root}」——同一提交上号必须一致`);
  }
  return { ok: problems.length === 0, problems, notes };
}

function readPkgs() {
  const out = {};
  for (const f of PKGS) {
    try {
      out[f] = String(JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')).version ?? '');
    } catch {
      out[f] = '<读不到>';
    }
  }
  return out;
}

function changelogTop() {
  let src;
  try {
    src = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  } catch {
    return null;
  }
  let best = null;
  for (const m of src.matchAll(/^## (v\d+\.\d+\.\d+)\b/gm)) if (best === null || cmp(m[1], best) > 0) best = m[1];
  return best;
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  } catch {
    return '';
  }
}

function tagFacts() {
  const merged = git(['tag', '--merged', 'HEAD', '--sort=-v:refname']).split(/\r?\n/).map((s) => s.trim()).filter((s) => parse(s));
  const head = git(['tag', '--points-at', 'HEAD']).split(/\r?\n/).map((s) => s.trim()).filter((s) => parse(s));
  return { highestTag: merged[0] ?? null, headTags: head };
}

function selftest() {
  const base = {
    pkgs: { 'package.json': '0.2.151', 'packages/shared/package.json': '0.2.151', 'packages/server/package.json': '0.2.151', 'packages/web/package.json': '0.2.151' },
    changelogTop: 'v0.2.151',
    highestTag: 'v0.2.151',
    headTags: ['v0.2.151'],
  };
  const cases = [
    { name: '全部一致 ⇒ 绿', facts: base, wantOk: true },
    { name: '带预发布后缀 ⇒ 红（两套号的根源就是它）', facts: { ...base, pkgs: { ...base.pkgs, 'package.json': '2.0.0-alpha.0' } }, wantOk: false },
    { name: 'workspace 与根不同号 ⇒ 红', facts: { ...base, pkgs: { ...base.pkgs, 'packages/web/package.json': '0.2.150' } }, wantOk: false },
    { name: 'CHANGELOG 顶部版本落后 ⇒ 红', facts: { ...base, changelogTop: 'v0.2.150' }, wantOk: false },
    { name: 'CHANGELOG 顶部版本领先 ⇒ 红', facts: { ...base, changelogTop: 'v0.2.152' }, wantOk: false },
    { name: 'tag 领先 package.json ⇒ 红（打了 tag 没改号）', facts: { ...base, highestTag: 'v0.2.152', headTags: [] }, wantOk: false },
    { name: 'package.json 领先 tag 一步 ⇒ 绿（发版前一刻）', facts: { ...base, pkgs: Object.fromEntries(PKGS.map((f) => [f, '0.2.152'])), changelogTop: 'v0.2.152', highestTag: 'v0.2.151', headTags: [] }, wantOk: true },
    { name: 'HEAD 上的 tag 与号不一致 ⇒ 红', facts: { ...base, headTags: ['v0.2.150'] }, wantOk: false },
    { name: '没有 tag 可核 ⇒ 绿并说明', facts: { ...base, highestTag: null, headTags: [] }, wantOk: true },
    { name: '比数值不比字符串（v0.2.10 领先 v0.2.9）', facts: { ...base, pkgs: Object.fromEntries(PKGS.map((f) => [f, '0.2.9'])), changelogTop: 'v0.2.9', highestTag: 'v0.2.10', headTags: [] }, wantOk: false },
  ];
  let bad = 0;
  // tag 形状：桌面线 `desktop-v0.1.0` 不能被当成站点版本号（否则它会把「最高已合并 tag」拉低或抬高）
  const shapeOk = parse('desktop-v0.1.0') === null && parse('v0.2.151') !== null && parse('0.2.151') !== null;
  if (!shapeOk) bad++;
  console.log(`${shapeOk ? '✓' : '✗'} 自证 只认 vX.Y.Z 形状的 tag（desktop-v* 不参与）`);
  for (const c of cases) {
    const got = judge(c.facts);
    const ok = got.ok === c.wantOk;
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} 自证 ${c.name} ⇒ ${got.ok ? '绿' : '红'}${got.problems.length ? `（${got.problems[0]}）` : ''}`);
  }
  console.log(bad === 0 ? '✓ check-version 自证通过：每条规则都会红' : `✗ check-version 自证失败 ${bad} 条`);
  return bad === 0 ? 0 : 1;
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const facts = { pkgs: readPkgs(), changelogTop: changelogTop(), ...tagFacts() };
  const r = judge(facts);
  for (const n of r.notes) console.log(`  · ${n}`);
  if (!r.ok) {
    for (const p of r.problems) console.error(`✗ [版本一致性] ${p}`);
    return 1;
  }
  console.log(`✓ 版本一致性：package.json×4 / CHANGELOG / tag 同为 ${facts.pkgs['package.json']}`);
  return 0;
}

process.exit(main());
