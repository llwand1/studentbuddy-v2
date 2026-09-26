// @vitest-environment node
/**
 * card-pixel.test.ts — 2026-09-26「像素风·数值层」批的**源码结构锁**。
 *
 * ★ 为什么单独一个文件：gates 卡 web 侧 `.ts` ≤400 行，这批锁并进 `card-motion.test.ts`
 *   之后是 427 行（现查）。拆文件比砍注释好——那些注释写的都是当时踩过的坑，砍掉就没了；
 *   而且两批锁的**口径**本来就不是一回事（那边＝升星动效的跨文件一致性＋配色，这边＝像素
 *   语言与特效预算）。helper 各自留一份（约 40 行）是这次拆分付出的代价。
 * ★ 老板那三档判决里可锁的部分：①像素风只进**数值层与特效层**，文字一律不动；
 *   ②特效加在 T3 彩带／高稀有卡扫描线／T2 方块粒子；③T1 仍然不加动画（契约 §8 频次红线）。
 *   审美（像素画得好不好看）**不锁**，那是 MT-36 的真人一票。
 * ★ 本文件有两条锁是**真浏览器量出来**的（B-022 合成层上限、轨填充色与卡体同色），
 *   量的脚本在 `tools/probes/cards-pixel-cdp.mjs`；死样式棘轮那条在 `card-motion.test.ts`。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../styles/game.css', import.meta.url), 'utf8');
const wall = readFileSync(new URL('./CardWall.tsx', import.meta.url), 'utf8');
const icons = readFileSync(new URL('../../components/game-icons.tsx', import.meta.url), 'utf8');
/** 像素图标的**全部**调用面：新增游戏组件时必须把它加进这张表，否则尺寸整除那条锁漏守一屏 */
const GAME_SCREENS = ['CardsView.tsx', 'CardWall.tsx', 'ChestPanel.tsx', 'TaskListPanel.tsx'].map(
  (f) => [f, readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')] as const,
);

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

/** 注释里那些 `animation:`／选择器不是代码，锁之前一律先剥掉。
   ★ 顺带把 CRLF 归一：本仓样式表是 CRLF，不归一的话任何带 `^` 的多行正则会先被 `\r` 撞掉，
     锁会**假失败**（假失败比假通过更烦人）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\r\n/g, '\n');
}
const RULE_RE = /([^{}]+)\{([^{}]*)\}/g;
function rules(src: string): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const m of stripComments(src).matchAll(RULE_RE)) {
    const sel = m[1];
    const body = m[2];
    if (sel && body) out.push([sel.trim().replace(/\s+/g, ' '), body] as const);
  }
  return out;
}
/** 逗号组选择器拆成单个复合选择器（本文件没有 `:is()`，拆开是安全的） */
function compounds(sel: string): string[] {
  return sel.split(',').map((s) => s.trim()).filter(Boolean);
}

const REDUCE_AT = css.indexOf('@media (prefers-reduced-motion: reduce)');
const CSS_BEFORE_REDUCE = css.slice(0, REDUCE_AT);
const CSS_REDUCE = css.slice(REDUCE_AT);

// ── 自定义属性表：跟 `var()` 间接引用追到字面量。
//    ★ 与 `card-motion.test.ts` 那份的唯一差别：这里多并了 `tokens.css`，因为本文件的
//      轨填充锁要判 `--gm-blue → --sb-primary → #007aff` 这一路（只并 game.css 会断在第二跳）。
const VARS = new Map<string, string>();
for (const src of [css, readFileSync(new URL('../../styles/tokens.css', import.meta.url), 'utf8')]) {
  for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const key = m[1];
    const value = m[2];
    if (key && value) VARS.set(key, value.trim());
  }
}
function literal(token: string, depth = 0): string {
  expect(depth, '自定义属性出现 var() 循环引用').toBeLessThan(8);
  const ref = token.match(/var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)/);
  if (!ref) return token.trim();
  const own = ref[1] ? VARS.get(ref[1]) : undefined;
  return literal(own ?? ref[2] ?? '', depth + 1);
}
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

describe('像素批 · 点阵精灵的几何', () => {
  const GRID = Number(icons.match(/export const PIXEL_GRID = (\d+)/)?.[1]);
  it('★ 每支 sprite 都是 `PIXEL_GRID` 方阵（行列数不齐＝`crispEdges` 下会被拉成歪的，且是肉眼最难发现的那种歪）', () => {
    expect(GRID, 'game-icons.tsx 里读不到 PIXEL_GRID').toBeGreaterThan(0);
    const region = icons.slice(icons.indexOf('const SPRITE'), icons.indexOf('type SpriteName'));
    const sprites = [...stripComments(region).matchAll(/^\s{2}(\w+):\s*\[([\s\S]*?)\],/gm)];
    expect(sprites.length, '一支 sprite 都没解析出来＝正则和源码结构漂了，本锁失效').toBeGreaterThanOrEqual(9);
    for (const m of sprites) {
      const name = m[1] ?? '?';
      const body = m[2] ?? '';
      const rows = [...body.matchAll(/'([^']*)'/g)].map((r) => r[1] ?? '');
      expect(rows.length, `${name} 的行数不是 ${GRID}`).toBe(GRID);
      for (const row of rows) expect(row.length, `${name} 有一行宽度不是 ${GRID}`).toBe(GRID);
      expect(body, `${name} 全是空格＝画了个隐形图标`).toMatch(/#/);
    }
  });

  it('★ 调用点尺寸必须是 `PIXEL_GRID` 的整数倍（非整数倍时一格会摊成 2.5 物理像素，硬边立刻发虚）', () => {
    const pixelNames = [...icons.matchAll(/export function (\w+Icon)/g)].map((m) => m[1] ?? '');
    expect(pixelNames.length).toBeGreaterThanOrEqual(9);
    let checked = 0;
    for (const [file, src] of GAME_SCREENS) {
      for (const m of src.matchAll(/<(\w+Icon)\s+size=\{(\d+)\}/g)) {
        const who = m[1] ?? '';
        if (!pixelNames.includes(who)) continue;   // 线稿图标（`icons.tsx`）不吃这条约束
        checked += 1;
        const size = Number(m[2]);
        expect(size % GRID, `${file} 的 ${who} size=${size} 不是 ${GRID} 的整数倍`).toBe(0);
      }
    }
    expect(checked, '一个像素图标调用点都没扫到＝正则漂了，本锁失效').toBeGreaterThanOrEqual(15);
  });

  it('★ 硬边落点：数值层的四个位（粒子／星槽／角标／进度轨）不许有圆角', () => {
    for (const sel of ['.gm-spark {', '.gm-stars > i {', '.gm-card-count {', '.gm-track.gm-px {']) {
      expect(block(sel), `${sel} 必须硬边`).toMatch(/border-radius:\s*0/);
    }
    // 粒子尺寸吃像素单元，不许再写回 9px 这类半格值
    expect(block('.gm-spark {')).toMatch(/width:\s*var\(--gm-px-row\)/);
  });

  it('★ 像素轨的填充色不许与所在档的卡体同色，分段遮罩三档共用（SSR 那条黄轨在真截图里是看不见的）', () => {
    /* 2026-09-26 无头 Edge 真截图自检逮到：首版 `.gm-track.gm-px.gm-epic > i` 把填充写成
       `var(--gm-yellow)`——而 SSR 卡体**就是同一个黄**——还顺手 `background-image: none`
       关掉白色分段遮罩，于是那一条在截图 `01-wall-top.png` 顶排六张上**完全读不出进度**。
       人眼复查会漏（轨还在、只是没颜色），所以锁在源码层，并且**按解析后的色值比**：
       只比 token 名的话，写 `var(--gm-r-ssr)` 会躲过、写 `var(--gm-yellow)` 更会躲过。 */
    /** 卡墙 `trackClass()` 的映射表（改了那边必须改这里，两边都是三档） */
    const TIERS = [['SSR', 'gm-epic'], ['SR', 'gm-rare'], ['R', 'gm-blue']] as const;
    let compared = 0;
    for (const [rarity, cls] of TIERS) {
      const body = block(`.gm-track.gm-px.${cls} > i {`);
      expect(body, `${cls} 关掉了分段遮罩＝三档共用的语言被拆了`).not.toMatch(/background-image:\s*none/);
      const fill = body.match(/background-color:\s*var\((--[\w-]+)\)/)?.[1] ?? '';
      const card = css.match(new RegExp(`\\.gm-card\\[data-r="${rarity}"\\][^}]*?--gm-cf:\\s*var\\((--[\\w-]+)\\)`))?.[1] ?? '';
      expect(fill, `${cls} 取不到填充色 token，本锁失效`).toBeTruthy();
      expect(card, `${rarity} 档取不到卡体色 token，本锁失效`).toBeTruthy();
      const fillHex = literal(`var(${fill})`);
      const cardHex = literal(`var(${card})`);
      expect(fillHex, `${cls} 的填充色解析不出字面量（写法变了？本锁要跟着改）`).toMatch(HEX);
      expect(cardHex, `${rarity} 的卡体色解析不出字面量`).toMatch(HEX);
      compared += 1;
      expect(fillHex.toLowerCase(), `${rarity} 卡的轨填充解析到 ${fillHex}，与卡体 ${cardHex} 同色＝看不见`)
        .not.toBe(cardHex.toLowerCase());
    }
    expect(compared, '一条色值都没比上＝token 写法变了，本锁已经失效').toBe(TIERS.length);
  });
});

describe('像素批 · 台阶缓动只许出现在 sprite 上', () => {
  const SPRITE_SEL = /\.gm-spark|\[data-r="SR"\]/;
  it('★ 用 `steps()` 的规则只能是粒子与 SR 扫描线（按钮／卡片位移吃台阶＝"卡顿"这个 bug）', () => {
    const users = rules(CSS_BEFORE_REDUCE).filter(([, b]) => /animation:[^;]*steps\(/.test(b));
    expect(users.length).toBeGreaterThanOrEqual(1);
    for (const [sel] of users) expect(sel, `${sel} 不该吃 steps`).toMatch(SPRITE_SEL);
    // `var(--gm-steps)` 这一路也要查，否则绕开上一条
    const viaVar = rules(CSS_BEFORE_REDUCE).filter(([, b]) => /animation:[^;]*var\(--gm-steps\)/.test(b));
    for (const [sel] of viaVar) expect(sel, `${sel} 不该吃 steps`).toMatch(SPRITE_SEL);
  });

  it('★ 台阶缓动是按区间生效的：被 steps 驱动的 keyframes 不许有"只写 opacity"的帧', () => {
    /* 插一帧只写 opacity ⇒ 位移被切成两段不等长的台阶（实测"一格一格"变成"几下抽搐"）。
       所以要么每帧都带 transform（gmSpark），要么干脆整条只有 transform（gmScan）。 */
    for (const name of ['gmSpark', 'gmScan']) {
      const body = stripComments(keyframes(name));   // 注释里也写着 opacity／transform，不剥会自己骗自己
      const frames = [...body.matchAll(/([\d%]+[^{]*)\{([^{}]*)\}/g)];
      expect(frames.length, `${name} 一个百分比帧都没解析出来`).toBeGreaterThan(0);
      for (const m of frames) {
        const at = m[1]?.trim() ?? '?';
        const decls = m[2] ?? '';
        if (/opacity/.test(decls)) {
          expect(decls, `${name} 的 ${at} 帧只写 opacity，会把台阶切歪`).toMatch(/transform/);
        }
      }
    }
  });
});

describe('像素批 · 特效颗数与降级面', () => {
  it('★ 彩带颗数两侧同数：`CONFETTI` ＝ `.gm-confetti > i:nth-child(1..n)` 连续无缺号', () => {
    const chest = readFileSync(new URL('./ChestPanel.tsx', import.meta.url), 'utf8');
    const n = Number(chest.match(/const CONFETTI = (\d+)/)?.[1]);
    expect(n, 'ChestPanel.tsx 里读不到 CONFETTI').toBeGreaterThan(0);
    const idx = [...css.matchAll(/\.gm-confetti > i:nth-child\((\d+)\)/g)].map((m) => Number(m[1]));
    expect(idx, '彩带偏移表缺号＝有几片叠在原地不动').toEqual(Array.from({ length: n }, (_, i) => i + 1));
  });

  it('★ 每条常驻动画都必须被 reduce 块以**同一串选择器**降级（不同特异度＝写了也白写）', () => {
    expect(REDUCE_AT, 'reduced-motion 那段被删了或挪到了文件中间，本锁会静默失效').toBeGreaterThan(0);
    const covered = new Set(
      rules(CSS_REDUCE).flatMap(([sel]) => compounds(sel)),
    );
    /** 豁免＝本就没有位移的动画，或它本身就是降级形态。逐条写理由，不许扩充成默认放行。 */
    const exempt: Record<string, string> = {
      '.gm-task-live': '只动 opacity（呼吸灯），reduced-motion 允许保留',
      '.gm-flip[data-r="SSR"] .gm-face::before': '只动 opacity（金边呼吸），同上',
    };
    const missing: string[] = [];
    for (const [sel, body] of rules(CSS_BEFORE_REDUCE)) {
      if (!/animation:|transition:/.test(body)) continue;
      for (const one of compounds(sel)) {
        if (covered.has(one) || exempt[one]) continue;
        missing.push(one);
      }
    }
    expect(missing, '这些选择器有动效却没被 reduce 块同名降级').toEqual([]);
    // 豁免表也不许变成死条目（源码改了却没回来删）
    for (const one of Object.keys(exempt)) {
      expect(rules(CSS_BEFORE_REDUCE).some(([s]) => compounds(s).includes(one)), `豁免项 ${one} 已不存在`).toBe(true);
    }
  });

  it('★ 进度轨必须有调用点，且数据驱动宽度带着 `gates:style-ok`（B-021 死样式反向锁）', () => {
    /* 首版 `game.css` 写了整节 `.gm-track`，全仓**一个调用点都没有**（现查 `*.tsx` 命中 0）——
       编译、单测、gates 全绿，画面上就是没有这条轨。所以这里反向锁一次：
       定义了就必须在屏上，否则要么接上要么删掉，不许留着当"以后会用到"。 */
    expect(wall, '.gm-track 又变成没人用的死样式了').toMatch(/className=\{`gm-track/);
    const at = wall.indexOf('className={`gm-track');
    expect(wall.slice(at, at + 260), '--gm-w 旁边没有 gates:style-ok 标注（CI 会拦，但这条锁更早告诉你）')
      .toContain('gates:style-ok');
    expect(block('.gm-track.gm-px > i {'), '分段靠 repeating 渐变，不许退回 JS 拼方块').toContain('repeating-linear-gradient');
  });

  it('★ 全息扫光必须挂在 `.gm-seen` 上（视口闸门＝合成层上限，见 `use-in-view.ts`）', () => {
    /* ★ 这条查的是**源码里真正带动画的那两条规则的选择器**，不是一份写死的字符串清单——
       后者是自证（把选择器改掉，清单还是那句清单）。反向实跑已验：去掉 `.gm-seen` 会红。 */
    const holo = rules(CSS_BEFORE_REDUCE)
      .filter(([, b]) => /animation:\s*gm(Sheen|Scan)\b/.test(b))
      .map(([sel]) => sel);
    expect(holo.length, '扫光规则一条都没解析出来＝本锁失效').toBe(2);
    for (const sel of holo) expect(sel, `${sel} 少了 .gm-seen 闸门`).toContain('.gm-seen');
    expect(wall).toContain('useInViewIds');
    expect(wall).toMatch(/data-tid=\{row\.termId\}/);
    /* ★★ B-022：视口闸**不是**上限——1360×900 实测一屏能铺 17 张 SR/SSR（无头 Edge 数
       `document.getAnimations()` 数出来的）。真正的上限是 `MAX_HOLO_LAYERS`，所以这里锁它存在、
       锁它是个位数；把它删掉或调回"随便多少层都行"＝红。`rootMargin` 那串也锁一次：
       上一批注释写 320px 而代码是 120px，这种漂移没人查（`game.css` §5 那条已改回现值）。 */
    const inView = readFileSync(new URL('./use-in-view.ts', import.meta.url), 'utf8');
    const cap = Number(inView.match(/MAX_HOLO_LAYERS = (\d+)/)?.[1]);
    expect(cap, 'MAX_HOLO_LAYERS 读不到＝上限没了或被改名（实测不封顶是 17 层，见 B-022）').toBeGreaterThan(0);
    expect(cap, '全息层上限 ≥ 9 等于没设（B-022 实测一屏 17 张）').toBeLessThanOrEqual(8);
    expect(inView, 'rootMargin 变了要同步改 game.css §5 那条"周期 ≥3s"的理由').toMatch(/rootMargin: '120px 0px'/);
    // 常驻循环的口径（★ 只扫 game.css，跨文件复用 `gmBreath` 的消费者不在里面）：
    // 墙上一直在的 ≤3 ＋ T3 面板内那一条不计（随卸载就没了）。真数一遍在册几条见 B-021 的现查。
    /* ★ 2026-09-26 现查：game.css 里 `infinite` 共 **4** 条（SSR 扫光／SR 扫描线／`.gm-task-live`
       呼吸灯／T3 金边），其中 `.gm-task-live` 是**死样式**（棘轮锁在 `card-motion.test.ts`）⇒ 屏上
       真在循环的只有前两条；第三条在 `cards-view.css` 的 `.cv-live`（复用 `gmBreath`，**不在这条锁的
       口径里**）。所以 3 这个上限是"含一条死的"才凑出来的——把死样式删掉时这里不会变红，别以为它
       自动收紧了。 */
    const loops = rules(CSS_BEFORE_REDUCE)
      .filter(([, b]) => /animation:[^;]*infinite/.test(b))
      .map(([sel]) => sel);
    const onWall = loops.filter((sel) => !sel.includes('.gm-flip'));
    expect(onWall.length, `常驻循环超标：${onWall.join(' / ')}`).toBeLessThanOrEqual(3);
    expect(loops.length, `循环动画总数超标（含 T3 面板内的）：${loops.join(' / ')}`).toBeLessThanOrEqual(4);
  });
});
