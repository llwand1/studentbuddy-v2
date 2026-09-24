/**
 * 「公开字节里不许出现内部字样」这条红线的**唯一一份**词表（渠道台账 C8 ＋ `docs/SEO-SPEC.md` §5 第 12 条）。
 *
 * ★ 为什么要有这么一个模块：同一族红线要扫四类字节——SPA 外壳、词条页、目录页、更新页与订阅。
 *   词表抄四遍，就会有一遍是旧的。这里一份，锁都从它取。
 * ★ 词表按「漏出去各自坏在哪」分四组，不是一张扁平清单：
 *   ①仓内路径与命令＝向竞品交出施工面；②服务器形状＝运维信息泄露（本站是 self-host，
 *   这条同时是产品叙事的一部分）；③口令字样＝真正的安全事故；
 *   ④内部挂账词汇＝把没做完的事、没验的账、内部称呼摆到对外的脸上。
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

export const INTERNAL_SHAPES: readonly RegExp[] = [
  ...REPO_SHAPES,
  ...SERVER_SHAPES,
  ...SECRET_SHAPES,
  ...LEDGER_WORDS,
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
  const haystack = allow.reduce((s, exact) => s.split(exact).join(' '), text);
  const hits: string[] = [];
  for (const re of INTERNAL_SHAPES) {
    const m = re.exec(haystack)?.[0];
    if (m && !hits.includes(m)) hits.push(m);
  }
  return hits;
}
