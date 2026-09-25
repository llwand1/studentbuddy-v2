// @vitest-environment node
/**
 * 「sitemap 里发出去的每一个地址，robots 都真的放了行」这把锁。
 *
 * ★ 它锁的不是「现在对不对」，而是**将来收窄前缀时会不会静默出事**：
 *   `robots.txt` 是「默认全封、逐条放行」，而英文词条页恰好嵌在 `/terms/` 这一扇
 *   **前缀**门下面。谁哪天把前缀改窄（哪怕只是为了限中文侧），英文页不会报错、
 *   不会构建失败，只会表现为收录量慢慢归零 —— 最难排查的那一种故障形状。
 * ★ 所以判据要从**发出去的东西**反推，不能从常量表正推：loc 是从 `renderSitemapXml()`
 *   的产物里正则抠出来的。改渲染逻辑多出一条 URL、或加语料多加一条 URL，
 *   忘了开门就在这儿红，而不是等到线上读收录才看见。
 * ★ 上一把锁只硬写了四个字符串（`public-hygiene.test.ts` 末尾那条），
 *   它挡得住「整行删掉」，挡不住「改成更窄的前缀」—— 差别就在这一把。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PUBLIC_TERMS } from './term-corpus';
import { PUBLIC_TERMS_EN } from './term-corpus-en';
import { renderSitemapXml } from './ssg';
import { CHANGELOG_PATH, FEED_PATH } from './paths';

const robotsText = readFileSync(new URL('../../public/robots.txt', import.meta.url), 'utf8');

type Kind = 'allow' | 'disallow';

interface Rule {
  kind: Kind;
  prefix: string;
  /** 结尾的 `$` 是 robots 协议的「整串精确匹配」，不是通配 */
  exact: boolean;
}

/**
 * 只解析 `User-agent: *` 那一组 —— 全站只声明了这一组，将来若按蜘蛛分节，
 * 这里要跟着扩，而漏扩会被「规则为空」那条用例挡回来。
 */
function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  let mine = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = (rawLine.split('#')[0] ?? '').trim();
    if (!line) continue;
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === 'user-agent') {
      mine = value === '*';
      continue;
    }
    if (!mine) continue;
    if (field !== 'allow' && field !== 'disallow') continue;
    if (!value) continue;
    rules.push({
      kind: field,
      prefix: value.endsWith('$') ? value.slice(0, -1) : value,
      exact: value.endsWith('$'),
    });
  }
  return rules;
}

/** 最长匹配者胜（爬虫的通行口径）；同长度时按放行算。 */
function isAllowed(pathname: string, rules: Rule[]): boolean {
  let bestLen = -1;
  let winner: Kind | null = null;
  for (const r of rules) {
    const hit = r.exact ? pathname === r.prefix : pathname.startsWith(r.prefix);
    if (!hit) continue;
    if (r.prefix.length > bestLen) {
      bestLen = r.prefix.length;
      winner = r.kind;
    } else if (r.prefix.length === bestLen && r.kind === 'allow') {
      winner = 'allow';
    }
  }
  return winner === 'allow';
}

/** sitemap 实际吐出去的每一个 URL 的路径部分 —— 判据的来源就是这份字节 */
function sitemapLocs(): string[] {
  const xml = renderSitemapXml(PUBLIC_TERMS, PUBLIC_TERMS_EN);
  return [...xml.matchAll(/<loc>https?:\/\/[^/]+(\/[^<]*)<\/loc>/g)].map((m) => m[1] ?? '');
}

describe('公开抓取许可 · sitemap 每个 loc 都要被 Allow 盖住', () => {
  const rules = parseRules(robotsText);
  const locs = sitemapLocs();

  it('★ 判据本身不许是空转：语料、loc、规则三边都要有货', () => {
    expect(PUBLIC_TERMS.length).toBeGreaterThan(0);
    expect(PUBLIC_TERMS_EN.length).toBeGreaterThan(0);
    // 首页 ＋ 中英两个目录页 ＋ 每条词条页 ＋ 计划表页
    expect(locs.length).toBe(PUBLIC_TERMS.length + PUBLIC_TERMS_EN.length + 4);
    expect(rules.length).toBeGreaterThan(5);
    // 这一组里既有中文侧也有英文侧，否则「盖得住」是假象
    expect(locs.filter((p) => p.startsWith('/terms/en/')).length).toBe(
      PUBLIC_TERMS_EN.length + 1,
    );
  });

  it('★ 每个 loc 都被放行，一个都不能漏（默认全封 ⇒ 漏了就是静默不公开）', () => {
    const blocked = locs.filter((p) => !isAllowed(p, rules));
    expect(blocked, `这些已进 sitemap 的地址在 robots 里没开门：${blocked.join(' , ')}`).toEqual(
      [],
    );
  });

  it('目录页之外的公开页（更新记录／订阅）也在清单上，它们不进 sitemap 但必须可抓', () => {
    for (const p of [CHANGELOG_PATH, FEED_PATH]) {
      expect(isAllowed(p, rules), `${p} 没开门`).toBe(true);
    }
  });

  it('★ 反向自证：把 `/terms/` 那扇前缀改窄 ⇒ 英文侧立刻落网（否则这把锁形同虚设）', () => {
    const narrowed = robotsText.replace('Allow: /terms/', 'Allow: /terms/zh/');
    expect(narrowed).not.toBe(robotsText);
    const after = parseRules(narrowed);
    const blocked = locs.filter((p) => !isAllowed(p, after));
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked).toContain('/terms/en/index.html');
    // 而中文侧那些 `/terms/xxx.html` 也一样落网 —— 说明判据真的在按前缀核，不是背字符串
    expect(blocked).toContain('/terms/index.html');
  });

  it('匹配器只认「前缀」与「结尾 $」两种形状，出现通配就先把锁说明白再放行', () => {
    // ⚠️ `*` 在 robots 协议里是通配符。本仓一条都没用过；真要用时得先给 isAllowed 补通配，
    //   否则它会当成字面量比较 —— 一把会撒谎的锁比没有锁更贵。
    const wild = rules.filter((r) => r.prefix.includes('*'));
    expect(wild.map((r) => r.prefix)).toEqual([]);
  });

  it('`$` 精确匹配没被读错：根页放行只盖住站点根，不顺手盖全站', () => {
    expect(isAllowed('/', rules)).toBe(true);
    expect(isAllowed('/some-private-app-route', rules)).toBe(false);
  });
});
