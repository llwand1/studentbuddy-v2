/**
 * 「公开字节里不许出现内部字样」这条红线的**唯一一份**词表（渠道台账 C8 ＋ `docs/SEO-SPEC.md` §5 第 12 条）。
 *
 * ★ 为什么要有这么一个模块：同一族红线要扫六类字节——SPA 外壳、词条页、目录页、更新页与订阅、
 *   英文侧那一批（批次 H-1 起），以及**构建产物里的 JS／CSS**（issue #8 起。此前一直不扫，
 *   依据是「压缩器会剥注释」这一没验过的推断——注释确实剥了，字符串常量原样留着）。
 *   词表抄四遍，就会有一遍是旧的。这里一份，锁都从它取。
 * ★ 词表按「漏出去各自坏在哪」分五组，不是一张扁平清单：
 *   ①仓内路径与命令＝向竞品交出施工面；②服务器形状＝运维信息泄露（本站是 self-host，
 *   这条同时是产品叙事的一部分）；③口令字样＝真正的安全事故；
 *   ④内部挂账词汇＝把没做完的事、没验的账、内部称呼摆到对外的脸上；
 *   ⑤拉丁写法＝①到④全是中文与路径形状，英文页需要一个只收「本仓的英文口头词」的第五组。
 * ★ 这条锁**只能挡住已经想到的写法**，挡不住没想到的说法——所以它旁边那条「内容源是手写清洗表」
 *   才是主结构：没写进语料的东西，正则再漏也漏不出去。
 */

/** ① 仓内路径与命令 */
const REPO_SHAPES: readonly RegExp[] = [/\bdocs\//, /\bpackages\//, /\bsrc\//, /\bnode_modules\b/, /\btools\//, /npm run/, /\bnpx\b/, /vite build/, /\btsx\b/, /git push/];

/** ② 服务器与部署形状（含本机开发端口） */
const SERVER_SHAPES: readonly RegExp[] = [
  /systemd/,
  /systemctl/,
  /\.service\b/,
  /\/opt\//,
  /\/var\/log/,
  /\/etc\//,
  /Caddyfile/,
  /\bcaddy\b/i,
  /127\.0\.0\.1/,
  /\blocalhost\b/i,
  /\bssh\b/,
  /:18791\b/,
  /:5173\b/,
  /:8787\b/,
  /:5199\b/,
  /:14210\b/,
];

/** ③ 口令与密钥字样 */
const SECRET_SHAPES: readonly RegExp[] = [/password/i, /\bsecret\b/i, /token\s*[:=]/i, /\bsk-[A-Za-z0-9]/, /\bBearer\s/, /\.env\b/, /\broot@/];

/** ④ 内部挂账词汇 */
const LEDGER_WORDS: readonly RegExp[] = [
  /挂账/,
  /未验账/,
  /老板/,
  /真人测试/,
  /判据/,
  /台账/,
  /验收/,
  /回标/,
  /工作面/,
  /门禁/,
  /施工/,
  /探针/,
  /在途/,
  /取证/,
  /拍板/,
  /批次/,
  /\bMT-\d/,
  /\bP[012]\b/,
];

/**
 * ⑤ 英文侧的内部字样（批次 H-1＝渠道 C1 英文侧）。
 * ★ 为什么前四组不够：前四组是**中文台账的词汇**，英文页一旦带出仓内文件名、命令名或
 *   施工口头词，一个都拦不住。这一组只收「本仓的英文写法」，不收通用英文词——
 *   收宽了就会红在正常讲解文案上，而那之后的下场是有人把整把锁拆掉。
 */
const LATIN_SHAPES: readonly RegExp[] = [
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bWIP\b/,
  /\bAGENTS\.md\b/,
  /\bCHANGELOG\.md\b/,
  /\btest-plan\b/,
  /\bdeploy\.sh\b/,
  /\bcheck\.mjs\b/,
  /\bworktree\b/,
  /\bnpm\b/,
  /\bpnpm\b/,
  /\bvitest\b/,
  /\beslint\b/,
  /\bvite\b/,
  /\btsc\b/,
  /\bsudo\b/,
  /\bnginx\b/,
  /\bplaceholder\b/,
  /\bstubbed?\b/,
  /\bmock(?:ed|s)?\b/,
  /\bgatekeep\w*/,
];

export const INTERNAL_SHAPES: readonly RegExp[] = [
  ...REPO_SHAPES,
  ...SERVER_SHAPES,
  ...SECRET_SHAPES,
  ...LEDGER_WORDS,
  ...LATIN_SHAPES,
];

/**
 * ★ 唯一一处白名单：SPA 外壳里 vite 那一句入口脚本。
 *   它是构建要求的字节，不是叙述——把 `.tsx` 算成「内部字样」等于要求改构建产物的形状。
 *   豁免写成**整串精确匹配**（含标签名与属性顺序），不是「凡带 src/ 都放行」；
 *   调用方只能拿这一条来比，且测试另外锁住「整份外壳里它至多出现一次」。
 */
export const SHELL_ENTRY_EXCEPTION = '<script type="module" src="/src/main.tsx"></script>';

/** 扫一段公开字节，返回命中的字样（每条最多报一次） */
export function internalWordingHits(text: string, allow: readonly string[] = []): string[] {
  return scanShapes(text, INTERNAL_SHAPES, allow);
}

function scanShapes(text: string, shapes: readonly RegExp[], allow: readonly string[] = []): string[] {
  const haystack = allow.reduce((s, exact) => s.split(exact).join(' '), text);
  const hits: string[] = [];
  for (const re of shapes) {
    const m = re.exec(haystack)?.[0];
    if (m && !hits.includes(m)) hits.push(m);
  }
  return hits;
}

/**
 * ── 构建产物那一路（`dist` 下的 `.js`／`.css`，issue #8）─────────────────────────
 *
 * ★ 为什么同一份词表还要另开一条通路：那五组形状是为**人写的散文**设计的，而压缩后的代码里
 *   有三类东西它们一律咬中：第三方库的常量（React 的错误解码地址、highlight.js 的关键字表与
 *   语言别名表）、DOM/CSS 自己的关键字（`placeholder`）、压缩器给的短标识符（`function P0(e)`）。
 *   把这些算成「内部字样」等于要求改第三方库，而那之后的下场还是有人拆锁（同第⑤组的理由）。
 * ★ 所以这里的规矩是**逐处点名豁免 ＋ 死锁自检**，不是「产物整类放行」：
 *   每条豁免写成一个具体的串（`BUNDLE_ALLOW`），测试再断言它**当场还在产物里出现**——
 *   依赖一升级、文案一改，豁免就变成死的，测试立刻红，逼重新看一眼。
 * ★ 只有 `BUNDLE_INAPPLICABLE` 那两条是整体不适用，且各自有东西顶上（口令那条换成
 *   「字面值」形状）；测试拿假 leak 钉住这两条不是偷懒。
 * ★ 实测账（2026-09-25，本机 `npm run build -w @sb/web` 后逐条数过）：JS 439 683 B ＋ CSS 147 405 B，
 *   未豁免前命中 12 条字样、其中本方自己写的只有 6 处中文文案（拍板 ×3、批次 ×3），其余全在第三方库常量里。
 */

/** 整体不适用的两条：在压缩代码里它们是必然，不是泄露 */
export const BUNDLE_INAPPLICABLE: readonly RegExp[] = [/\bP[012]\b/, /password/i];

/**
 * 顶替 `/password/i` 的形状：`password` 当字段名是本产品的实现词汇（注册、登录、改密都要它），
 * 只有**被赋成字符串常量**才是把口令写进了前端——那正是这条要守的。
 */
const BUNDLE_SECRET_SHAPES: readonly RegExp[] = [/passw(?:or)?d\w*\s*[:=]\s*["'`][^"'`\s]{4,}["'`]/i];

/**
 * 按 **source 字符串**比对，不按对象身份。
 * ★ 两处字面量写法相同的正则是两个不同对象，`includes(re)` 恒为 false —— 那样「这两条整体不适用」
 *   会静默失效，产物扫描永远红在 `P0` 与 `password` 上，而下一次有人做的东西就是把整段豁免删掉。
 */
const INAPPLICABLE_SOURCES = new Set(BUNDLE_INAPPLICABLE.map((re) => re.source));

const BUNDLE_SHAPES: readonly RegExp[] = [
  ...INTERNAL_SHAPES.filter((re) => !INAPPLICABLE_SOURCES.has(re.source)),
  ...BUNDLE_SECRET_SHAPES,
];

export interface BundleAllow {
  readonly needle: string;
  readonly why: string;
}

/** 逐处点名的豁免（每条都要在产物里真的出现，否则测试红） */
export const BUNDLE_ALLOW: readonly BundleAllow[] = [
  { needle: 'reactjs.org/docs/error-decoder.html', why: 'React 自带的错误解码地址，指向 React 官网' },
  { needle: '/api/tools/', why: '本站公开的 API 前缀，被「仓内 tools/ 目录」那条撞中' },
  { needle: 'exit|npm|npx|node|git|sudo|mkdir', why: 'highlight.js 的 shell 关键字表，出现是为了给代码块上色' },
  { needle: 'tsx:"js"', why: 'highlight.js 语言别名表里的一项（键与值都算上，只放过一半会残下值里那个 tsx）' },
  { needle: 'tsx:"tsx"', why: '同上，另一张表里它映射到自己' },
  { needle: 'pk-sk-line', why: '骨架屏 class 名，撞在密钥形状 sk- 上' },
  { needle: 'placeholder:', why: 'React DOM 属性名，不是「占位内容没填」' },
  { needle: 'placeholder,value:', why: '同一个属性在压缩后以对象属性形式被读走（`x.placeholder, value:…`）' },
  { needle: '::placeholder', why: 'CSS 伪元素选择器' },
  { needle: '让你拍板', why: '产品对自己用户说话的口径（追问模式说明），不是内部决策用语' },
  { needle: '需要你拍板', why: '选项卡的等待态文案，同上' },
  { needle: '撤销删除批次', why: '「批次」在这里是产品自己的名词（一批删除可撤销），不是内部排期用语' },
  { needle: '未过期批次', why: '同上，设置页提示' },
  { needle: '个批次未列出', why: '同上，撤销条折叠提示' },
];

/** 扫构建产物字节（JS／CSS）：同一份词表，减去整体不适用那两条，加上代码表面那条口令形状 */
export function bundleWordingHits(text: string): string[] {
  return scanShapes(text, BUNDLE_SHAPES, BUNDLE_ALLOW.map((a) => a.needle));
}
