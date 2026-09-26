// @vitest-environment node
/**
 * 卡墙动效与配色的**源码结构锁**。
 *
 * ★ 为什么样式也要锁：B-020 那六条全是"编译／单测／gates 全绿而画面是错的"，
 *   其中 ⑥（升星那一下看不见）修的时候量出两条**写不出运行态断言、但写得成源码断言**的事：
 *   ① 环与 16 颗粒子原本靠 `inset: 0; margin: auto` 居中，被 `cards-view.css` 的
 *     `.cv-card > * { margin: 0 }`（同特异度、import 更晚）吃掉 ⇒ 从卡片**左上角**往外炸；
 *   ② 粒子数在 `CardWall.tsx` 的 `SPARKS` 与 `game.css` 的 `nth-child` 偏移表**各写一份**，
 *     少改一侧就有几颗叠在中心不动。
 *   ⇒ 这两条都不是审美判断（那类不锁，见 `manual-test.md` MT-35），而是**跨文件一致性**，
 *     跨文件一致性是本仓一贯的锁形（同族：`og-card.test.ts` 拿 `tokens.css` 现值对配色）。
 * ★ 另锁一条**可计算**的：稀有度整块饱和之后卡内小字与卡底的 WCAG 对比度成了新闸门；
 *   改色不改字号（11～14px 一律按小字算 4.5）必须红，不能等人眼事后发现。
 * ★ 2026-09-26 像素批的锁不在这个文件里：加进来会撞 gates 的 web `.ts` ≤400 行（现查 427），
 *   所以拆成同目录的 `card-pixel.test.ts`，两本各留一份 helper。这里只留 B-021 的死样式棘轮。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../styles/game.css', import.meta.url), 'utf8');
const wall = readFileSync(new URL('./CardWall.tsx', import.meta.url), 'utf8');
const cardsCss = readFileSync(new URL('./cards-view.css', import.meta.url), 'utf8');
// ⚠️ 像素图标／GAME_SCREENS／rules()／reduce 分段这几份 helper 跟着像素批的锁一起搬到了
//    `card-pixel.test.ts`（本文件用不到它们了）。留着就是 B-021 说的那种"定义了但没人用"。

/** 一个规则块的正文（本仓样式块不嵌套，取到最近的 `}` 即可） */
function block(selector: string, src: string = css): string {
  const at = src.indexOf(selector);
  expect(at, `源码里找不到选择器 ${selector}`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf('{', at);
  return src.slice(open + 1, src.indexOf('}', open));
}

/** 一个 @keyframes 的正文（以行首 `}` 收尾） */
function keyframes(name: string): string {
  const at = css.indexOf(`@keyframes ${name}`);
  expect(at, `源码里找不到 @keyframes ${name}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('\n}', open));
}

const SPARK_OFFSET_RE = /\.gm-burst \.gm-spark:nth-child\((\d+)\)/g;
const SPARK_DELAY_RE = /\.gm-burst \.gm-spark:nth-child\(\d+\)\s*\{[^}]*animation-delay:\s*(\d+)ms/g;

/** 注释里那些 `animation:`／选择器不是代码，锁之前一律先剥掉。
   ★ 顺带把 CRLF 归一：本仓样式表与这两个测试文件都是 CRLF，不归一的话任何带 `^` 的
     多行正则会先被 `\r` 撞掉，锁会**假失败**（假失败比假通过更烦人）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\r\n/g, '\n');
}

// ── 自定义属性表：跟 `var()` 间接引用追到字面量 ──────────────────────────────
const VARS = new Map<string, string>();
for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
  const key = m[1];
  const value = m[2];
  if (key && value) VARS.set(key, value.trim());
}
function literal(token: string, depth = 0): string {
  expect(depth, '自定义属性出现 var() 循环引用').toBeLessThan(8);
  const ref = token.match(/var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)/);
  if (!ref) return token.trim();
  const own = ref[1] ? VARS.get(ref[1]) : undefined;
  return literal(own ?? ref[2] ?? '', depth + 1);
}

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** WCAG 2.1 相对亮度（sRGB 线性化后按 .2126/.7152/.0722 加权） */
function luminance(hex: string): number {
  const body = hex.slice(1);
  const quad = body.length === 3 || body.length === 4 ? body.replace(/./g, (c) => c + c) : body;
  const chan = (i: number): number => {
    const raw = parseInt(quad.slice(i, i + 2), 16) / 255;
    return raw <= 0.04045 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)] as const;
  const hi = Math.max(x, y);
  const lo = Math.min(x, y);
  return (hi + 0.05) / (lo + 0.05);
}

const TIERS = ['N', 'R', 'SR', 'SSR'] as const;

describe('卡墙 · 升星动效的跨文件一致性（B-020 ⑥ 的两条实测根因）', () => {
  it('★ 粒子数两侧同数：`SPARKS` ＝ `game.css` 里 `.gm-spark:nth-child(...)` 的条数，且序号从 1 连续', () => {
    const sparks = Number(wall.match(/const SPARKS = (\d+)/)?.[1]);
    expect(sparks, 'CardWall.tsx 里读不到 SPARKS').toBeGreaterThan(0);
    const offsets = [...css.matchAll(SPARK_OFFSET_RE)].map((m) => Number(m[1]));
    expect(offsets, '偏移表缺号＝有粒子叠在中心不动').toEqual(Array.from({ length: sparks }, (_, i) => i + 1));
  });

  it('★ 环与粒子不许依赖 margin 居中（会被 `.cv-card > * { margin: 0 }` 吃掉），必须自己 translate 回中', () => {
    expect(block('.cv-card > * {', cardsCss), '前提变了：那条清外边距的规则不在了，本锁的靶子要一起删').toMatch(/margin:\s*0/);
    for (const sel of ['.gm-ring {', '.gm-spark {']) {
      const body = block(sel);
      expect(body, `${sel} 不许再用 margin 居中`).not.toMatch(/margin:\s*auto/);
      expect(body, `${sel} 必须自己定位到卡片中心`).toMatch(/left:\s*50%/);
      expect(body, `${sel} 必须自己定位到卡片中心`).toMatch(/top:\s*50%/);
    }
    for (const kf of ['gmRing', 'gmSpark']) {
      expect(keyframes(kf), `${kf} 的每一帧都得带着回中位移，否则中途会跳回左上角`).toContain('translate(-50%, -50%)');
    }
  });

  it('★ 爆帧时长不许把动画拦腰截断：末颗延迟＋粒子寿命 ≤ `BURST_MS`', () => {
    const burstMs = Number(wall.match(/const BURST_MS = (\d+)/)?.[1]);
    const life = Number(block('.gm-burst .gm-spark {').match(/animation:\s*gmSpark (\d+)ms/)?.[1]);
    const delays = [...css.matchAll(SPARK_DELAY_RE)].map((m) => Number(m[1]));
    expect(burstMs).toBeGreaterThan(0);
    expect(delays.length).toBeGreaterThan(0);
    expect(life + Math.max(...delays), '动画没跑完就摘类＝粒子被拦腰砍').toBeLessThanOrEqual(burstMs);
  });

  it('★ 粒子与环不许"一闪就没"：keyframes 里透明度要有中途停留点（整条交给 ease-out 时实测 380ms 只剩 2 颗）', () => {
    const holds = (body: string): number => [...body.matchAll(/\d+%\s*\{[^}]*opacity/g)].length;
    expect(holds(keyframes('gmSpark')), 'gmSpark 缺中途 opacity 停留点').toBeGreaterThanOrEqual(1);
    expect(holds(keyframes('gmRing')), 'gmRing 缺中途 opacity 停留点').toBeGreaterThanOrEqual(1);
  });
});

describe('卡墙 · 稀有度整块饱和后的可读性', () => {
  it('★ 每档四个值齐备（底／厚边／主字／次级字），少一个就有一类文字压在新底色上看不见', () => {
    for (const tier of TIERS) {
      const body = block(`.gm-card[data-r="${tier}"] {`);
      for (const v of ['--gm-cf', '--gm-cfd', '--gm-on', '--gm-on-dim']) {
        expect(body, `${tier} 档缺 ${v}`).toContain(`${v}:`);
      }
    }
  });

  it('★ 卡内小字对卡底的对比度 ≥ AA 小字门槛 4.5（标题 11～14px 一律按小字算）', () => {
    for (const tier of TIERS) {
      const bg = literal(VARS.get(`--gm-r-${tier.toLowerCase()}`) ?? '');
      expect(bg, `${tier} 档底色解析不出字面量`).toMatch(HEX);
      for (const kind of ['ink', 'dim'] as const) {
        const fg = literal(VARS.get(`--gm-r-${tier.toLowerCase()}-${kind}`) ?? '');
        expect(fg, `${tier}-${kind} 解析不出字面量`).toMatch(HEX);
        const ratio = contrast(bg, fg);
        expect(ratio, `${tier} 档 ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('★ 卡面角标「N 张」不许拿卡底色当字色（整块饱和之后那样等于隐身）', () => {
    const body = block('.gm-card-count {');
    expect(body).toContain('var(--gm-on)');
    /* ⚠️ 2026-09-26 像素批把这条的**判定位置**收紧了：原来写的是 `not.toMatch(/--gm-cf/)`，
         而角标换硬边框之后合法地用了 `--gm-cfd`（厚边那档深色），`--gm-cf` 是它的**前缀**
         ⇒ 旧正则被自己的前缀撞了。不变量从来只是「字色不许吃卡底」，那就只查 `color:` 这一条声明。 */
    expect(body, '角标字色不许吃卡底（`--gm-cf` 是背景，不是文字）').not.toMatch(/color:\s*var\(--gm-cf/);
  });

  it('★ 领域小标签要是不透明底、且不许被 flex 列拉成整条白底', () => {
    const body = block('.gm-card-dom {');
    expect(body, '半透明层无法脱离背景单独量对比度').toMatch(/background:\s*var\(--gm-surface\)/);
    expect(body, 'flex 列里 stretch 会把小标签拉成整条').toMatch(/align-self:\s*flex-start/);
  });
});

/* ═══════════════════ B-021 · 死样式棘轮 ═══════════════════
   本批现查的来路：首版 `game.css` 写了整节 `.gm-track`，全仓**一个调用点都没有**（编译／单测／gates
   全绿，画面上就是没这条轨）。像素批把它接进卡墙之后重扫，还剩 4 条同样零调用点的规则。
   ★ 这条锁**不禁止死样式**——它禁止**第 5 条**：名单是冻结的，新写一条没人挂的样式要么接上调用点，
     要么从名单里删掉（删的同时就得在台账里交代）。 */
describe('B-021 · game.css 里「定义了但屏上没有」的样式不许继续长', () => {
  /** 冻结名单（2026-09-26 现查：规则里 `.gm-*` 名字 59 个、扫过 128 个 tsx）。
      值只写**这条规则画的是什么**，不猜"为什么没人用"。 */
  const DEAD: Record<string, string> = {
    'gm-gloss': '进度轨的高光层（`> i::after`，纯装饰）',
    'gm-danger': '`.gm-btn` 的红色档',
    'gm-fly': '飞卡归位的位移轨道（`position: fixed` ＋ `--gm-fx/--gm-fy`）',
    'gm-task-live': '任务列表那盏呼吸灯（屏上实际在呼吸的是 `cards-view.css` 的 `.cv-live`）',
  };
  /** 假阳性：类名由 `CardWall.tsx` 的 `domClass()` 动态拼出，静态扫文本扫不到 */
  const DYNAMIC = ['gm-d1', 'gm-d2', 'gm-d3', 'gm-d4', 'gm-d5'];

  const tsxSources = (() => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.tsx')) out.push(readFileSync(p, 'utf8'));
      }
    };
    walk(fileURLToPath(new URL('../../', import.meta.url)));
    return out;
  })();

  /** 只认**规则选择器**里的名字：注释里点名而根本没有规则的（`.gm-row`／`.gm-fill`）不算样式，
      那两条是另一件事，写在 B-021 的"注释撒谎"那一格。 */
  const defined = new Set<string>();
  for (const m of stripComments(css).matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const n of (m[1] ?? '').matchAll(/\.gm-[a-z0-9-]+/g)) defined.add(n[0].slice(1));
  }
  /** 按整词匹配，不吃前缀：`gm-card` 不能因为源码里有 `gm-card-count` 就算被调用 */
  const calledSomewhere = (name: string): boolean =>
    tsxSources.some((s) => new RegExp(`(?<![-\\w])${name}(?![-\\w])`).test(s));

  it('★ 零调用点的规则必须等于冻结名单（新写一条没人用的样式＝红）', () => {
    expect(defined.size, '一个 .gm-* 都没解析出来＝正则漂了，本锁失效').toBeGreaterThanOrEqual(50);
    expect(tsxSources.length, '没扫到 tsx 调用面，本锁失效').toBeGreaterThanOrEqual(100);
    expect(wall, '`.gm-d*` 的拼法变了（现为 `gm-d${domIndex + 1}`），DYNAMIC 名单要跟着重算')
      .toMatch(/`gm-d\$\{domIndex \+ 1\}`/);
    const dead = [...defined].filter((n) => !calledSomewhere(n)).sort();
    expect(dead, `名单外出现新的死样式，或缺少名单内的条目：${dead.join(' / ')}`)
      .toEqual([...Object.keys(DEAD), ...DYNAMIC].sort());
  });
});
