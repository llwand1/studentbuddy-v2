// @vitest-environment jsdom
/**
 * LandingLang.test — 中英切换**底座**的锁（2026-09-22 老板点单：「还有一些使用英语的访客」）。
 *
 * ★ 这一批有二十来个文件改了文案口径，绝大多数存量锁因此挪去钉中文（`Landing.test.tsx` 在
 *   模块顶层写了一次 `localStorage`）。那些锁守的是**门面动线**，与语言无关；本文件守的才是
 *   本批新增的三条性质，按「坏了最没人发现」排序：
 *   ① **英文侧真的上屏**：切换键点下去，整页读数是英文的（漏接一句 `[lang]` 只会静默留中文，
 *      存量锁全在中文口径，一条都逮不到）；
 *   ② **首探与记忆的优先级**：没手动选过时按 `navigator.language` 判，选过之后记忆说话——
 *      搞反了会让中文用户每次访问都被切成英文（或者英文访客永远困在中文）；
 *   ③ **打字机预算**：两语共用帧时长，逐字揭示必须**各自**走完在首帧之内。这条以前只是
 *      registry 里的一句注释，现在机器可查（导出 `SPEED/LEAD/TAIL/SEG1/SEG2` 就是为了这笔账）。
 * ★ 另加两条「别把演示做成产品里没有的东西」：高亮词必须真的出现在正文里；
 *   两块屏的屏态矩阵与语言无关（英文侧想偷偷换屏态，得先改 `pk-frames` 的表类型）。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react';
import { HELP_PER_MATCH } from '@sb/shared';
import { LANDING_LANG_KEY, LandingLangProvider, LangToggle, initialLandingLang } from './landing-lang';
import { BRAND_TAGLINE, DEMO_BTN, FOOT_CHANGELOG, FOOT_TERMS, HERO } from './landing-copy';
import { CATALOG_PATH, CHANGELOG_PATH } from '../seo/paths';
import { Landing } from './Landing';
import { LandingBrand, totalTicks } from './LandingBrand';
import { GraphDemo } from './demo/GraphDemo';
import { PkJourney } from './PkJourney';
import { ASK, LEAD, SEG1, SEG2, SPEED, TAIL, TERMS } from './demo/TermFlowDemo';
import { TERM_FLOW } from './demo/registry';
import {
  CLIP_MAX,
  DEMO_ASK,
  FRAME,
  GRAPH_LEGEND,
  NODE_KIND_TEXT,
  NODE_TEXTS,
  nodeText,
} from './demo/graph-demo';
import { PK_FRAMES } from './pk-frames';
import { T } from './pk-copy';
import type { LandingLang } from './landing-lang';

const LANGS: LandingLang[] = ['zh', 'en'];
const setNav = (v: string) => Object.defineProperty(window.navigator, 'language', { value: v, configurable: true });
const store = (v: string | null) => (v === null ? window.localStorage.removeItem(LANDING_LANG_KEY) : window.localStorage.setItem(LANDING_LANG_KEY, v));

/** `Landing` 会挂 `AccountBox` 与 `DemoLoginButton`，两者都碰 `lib/api` ⇒ 整门 mock（同 `Landing.test.tsx`） */
vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string, public body?: unknown) {
      super(message);
    }
  },
  api: {
    auth: {
      me: () => Promise.reject(new Error('401')),
      // ★ 2026-09-24 归因批：`Landing` 的 providers 请求从裸 `fetch` 换成了 `api.auth.surface()`
      //   （那条请求是服务端 `app_open` 的采集点，归因头只在 api 层注入）。桩点跟着上移一层。
      surface: () => Promise.resolve({ providers: { github: false, demo: true }, form: 'cloud' }),
      sendCode: () => Promise.resolve({ ok: true, expiresInMs: 60_000 }),
      register: () => Promise.reject(new Error('unused')),
      demoLogin: () => Promise.reject(new Error('unused')),
    },
  },
}));

beforeEach(() => {
  window.localStorage.clear();
  setNav('en-US'); // jsdom 本来就是 en-US；写明是因为下面的用例要改它
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const title = (container: HTMLElement) => container.querySelector('.landing-title')?.textContent ?? '';

describe('落地页双语 — 英文侧真的上屏', () => {
  it('非中文浏览器首探即英文：hero 标题与体验警示都是英文那一侧', async () => {
    const { container, findByText } = render(<Landing onAuthed={() => undefined} />);
    expect(title(container)).toBe(`${HERO.titlePre.en}${HERO.titleAccent.en}`);
    // §2.10 的决策落点：共享池警示对看不懂中文的英文访客失效＝没警示
    // （★ 体验入口要等 `/api/auth/providers` 回来才画 ⇒ 这里必须 await，同步 getByText 会先扑空）
    expect(await findByText(DEMO_BTN.warn.en)).toBeTruthy();
  });

  it('★ 页眉切换键：点「中文」→ 整页换血，并把选择写进 localStorage', () => {
    const { container } = render(<Landing onAuthed={() => undefined} />);
    expect(title(container)).toBe(`${HERO.titlePre.en}${HERO.titleAccent.en}`);
    fireEvent.click(screen.getByRole('button', { name: '中文' }));
    expect(title(container)).toBe(`${HERO.titlePre.zh}${HERO.titleAccent.zh}`);
    expect(window.localStorage.getItem(LANDING_LANG_KEY)).toBe('zh');
    expect(screen.getByRole('button', { name: 'EN' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: '中文' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('切换键两枚永远都在（语言名不翻译：中文 / EN 各自写自己）', () => {
    render(
      <LandingLangProvider>
        <LangToggle />
      </LandingLangProvider>,
    );
    expect(screen.getByRole('group', { name: '语言 / Language' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '中文' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'EN' })).toBeTruthy();
  });

  it('★ 顶栏品牌牌打字机在 EN 侧也得走完（总格数若仍按中文副标算，英文副标会永远差 17 个字母）', () => {
    // `LandingBrand` 的时钟按「名字 12 格 + 停 4 格 + 副标若干格」走，副标格数**必须跟着语言变**：
    // 中文侧 8 字、英文侧 25 字。写死任一侧的症状都是**静默**的——少了就是副标被截断、
    // 且那个复用产品流式光标的 `.chat-caret` 永远亮着（打完才摘）。
    vi.useFakeTimers();
    store('en');
    const { container } = render(
      <LandingLangProvider>
        <LandingBrand />
      </LandingLangProvider>,
    );
    // ★ 逐格推进、每格一次 `act`：下一格的表要等 React 提交上一次更新之后才挂，
    //   一次 `advanceTimersByTime(总额)` 推到底只会烧掉第一格（存量锁实测踩过）。
    //   步长取 100ms 而非组件的 70ms：只要 ≥ STEP_MS，一次 act 就恰好推进一格。
    const ticks = totalTicks(BRAND_TAGLINE.en.length) + 2;
    for (let i = 0; i < ticks; i += 1) act(() => vi.advanceTimersByTime(100));
    expect(container.querySelector('.landing-brand-name')?.textContent).toBe('studentbuddy');
    expect(container.querySelector('.landing-brand-tag')?.textContent).toBe(BRAND_TAGLINE.en);
    expect(container.querySelector('.chat-caret'), '打完还挂着光标 ⇒ 它以为没打完').toBeNull();
    cleanup();
    vi.useRealTimers();
  });
});

describe('落地页双语 — 记忆优先于浏览器语言', () => {
  it('存过 zh 就不再让自动判定插手（哪怕浏览器是英文）', () => {
    store('zh');
    const { container } = render(<Landing onAuthed={() => undefined} />);
    expect(title(container)).toBe(`${HERO.titlePre.zh}${HERO.titleAccent.zh}`);
  });

  it('存过 en 就不再切回中文（哪怕浏览器是 zh-CN）', () => {
    store('en');
    setNav('zh-CN');
    const { container } = render(<Landing onAuthed={() => undefined} />);
    expect(title(container)).toBe(`${HERO.titlePre.en}${HERO.titleAccent.en}`);
  });

  it('★ `initialLandingLang` 的四种情形：记忆 > 首探，脏值按没存过', () => {
    store(null);
    setNav('zh-CN');
    expect(initialLandingLang()).toBe('zh');
    setNav('zh'); // 只写语言码、不带地区的浏览器
    expect(initialLandingLang()).toBe('zh');
    setNav('en-US');
    expect(initialLandingLang()).toBe('en');
    store('zh');
    expect(initialLandingLang()).toBe('zh'); // 记忆压过 zh→en 的反向首探
    store('fr'); // 脏值（别的系统往这个键里塞了东西）
    expect(initialLandingLang(), '脏值必须按没存过处理').toBe('en');
    store(null);
    expect(initialLandingLang()).toBe('en');
  });
});

describe('落地页双语 — 两语都得在产品事实之内', () => {
  it('★ 打字机预算：两语的逐字揭示都必须走完在首帧 ms 之内（帧时长两语共用）', () => {
    const first = TERM_FLOW.stages[0];
    if (!first) throw new Error('词条演示的帧序变了 ⇒ 本锁按新帧号重算，别直接删');
    for (const lang of LANGS) {
      const cost = LEAD + SEG1[lang].length * SPEED[lang] + TAIL + SEG2[lang].length * SPEED[lang];
      expect(cost, `${lang} 侧逐字要 ${cost}ms，首帧只有 ${first.ms}ms ⇒ 字会被切在半路`).toBeLessThanOrEqual(first.ms);
    }
    // EN 更快不是随手取的数：真机 SSE 吐英文时每包近两倍的字符，沿用 42ms 是给英文装了台慢放机
    expect(SPEED.en).toBeLessThan(SPEED.zh);
  });

  it('★ 高亮词必须真的出现在打字的那两段里（否则首现/复现两档线型演不出来）', () => {
    for (const lang of LANGS) {
      const body = SEG1[lang] + SEG2[lang];
      for (const term of TERMS[lang]) expect(body, `${lang} 侧正文里没有「${term}」，标不出来`).toContain(term);
      // 复现那一档靠「同一个词出现两次」，两语都得有这个词
      const again = TERMS[lang].find((t) => body.split(t).length - 1 >= 2);
      expect(again, `${lang} 侧没有任何一个词出现两次 ⇒ 复现虚点线演不出来`).toBeTruthy();
    }
    expect(ASK[LANGS[0]!]).toBeTruthy(); // 提问气泡两语都得有字
  });

  it('★ 英文侧的节点名放得进 92px 卡片（超限会被 `clipLabel` 截成「…」，与抽词清单当场对不上）', () => {
    for (const id of Object.keys(NODE_TEXTS)) {
      for (const lang of LANGS) expect(nodeText(id, lang).length, `${lang} 侧 ${id} 超宽`).toBeLessThanOrEqual(CLIP_MAX[lang]);
    }
  });

  it('知识图演示切到 EN：按钮、角标、图例全换成英文，中文侧仍说自己那套', () => {
    const board = (stage: number) =>
      render(
        <LandingLangProvider>
          <GraphDemo stage={stage} />
        </LandingLangProvider>,
      ).container;
    store('en');
    const en = board(FRAME.ask);
    expect(en.querySelector('.ld-g-ask text')?.textContent).toBe(DEMO_ASK.button.en);
    expect(en.querySelector('.ld-g-n.on .gr-node-name')?.textContent).toBe(nodeText('g-center', 'en'));
    expect(en.querySelector('.ld-g-n.on .gr-node-kind')?.textContent).toBe(NODE_KIND_TEXT.term.en);
    cleanup();
    store('zh');
    const zh = board(FRAME.ask);
    expect(zh.querySelector('.ld-g-ask text')?.textContent).toBe(DEMO_ASK.button.zh);
    expect(zh.querySelector('.ld-g-n.on .gr-node-name')?.textContent).toBe(nodeText('g-center', 'zh'));
    expect(zh.querySelector('.ld-g-n.on .gr-node-kind')?.textContent).toBe(NODE_KIND_TEXT.term.zh);
    cleanup();
    // ★ 图例那两条限定词两语都得在（缺了「未经确认」，读者会以为 AI 连的线可信）。
    //   图例只在末帧 `.on`，故必须在 `FRAME.origin` 那两帧各读一次，而不是在帧 1 上摸。
    for (const lang of LANGS) {
      store(lang);
      const el = board(FRAME.origin).querySelector('.ld-g-legend');
      expect(el?.classList.contains('on'), `${lang} 侧末帧图例没亮`).toBe(true);
      for (const { text } of GRAPH_LEGEND) expect(el?.textContent).toContain(text[lang]);
      cleanup();
    }
  });
});

describe('落地页双语 — 两块屏的屏态与语言无关', () => {
  it('EN 口径下仍恰好两块屏、五步说明、主题归属各说一遍', () => {
    store('en');
    const { container } = render(
      <LandingLangProvider>
        <PkJourney />
      </LandingLangProvider>,
    );
    const boards = Array.from(container.querySelectorAll('.landing-pk-screen'));
    expect(boards.length).toBe(2);
    expect(container.querySelectorAll('.landing-pk-steps .landing-jstep').length).toBe(PK_FRAMES.length);
    const owners = boards.map((el) => el.querySelector('.sb-pk-topic-owner')?.textContent);
    expect(owners.filter((s) => s === T.yourTopic.en).length).toBe(1); // ★ 不是两块屏同一个词＝上帝视角
    expect(owners.filter((s) => s === T.rivalTopic.en).length).toBe(1);
    const topics = boards.map((el) => el.querySelector('.sb-pk-topic-name')?.textContent);
    expect(topics[0]).toBe(topics[1]); // 主题本身是公开快照的一部分，两侧同值
  });

  it('★ 屏上每个数在英文侧同样要「产品里可能出现」：求助数 ≤ 每局道具上限', () => {
    // 与 `PkJourney.test.tsx` 同一条不变量，换到英文读数上再跑一遍——那条锁的读法是中文的
    // （`求助 N`），英文侧写作 `N help`。上一批翻出「求助 2」的就是这条口径。
    store('en');
    const { container } = render(
      <LandingLangProvider>
        <PkJourney />
      </LandingLangProvider>,
    );
    const subs = Array.from(container.querySelectorAll('.landing-pk-screen .sb-pk-sub')).map((n) => n.textContent ?? '');
    expect(subs.length).toBe(2);
    for (const text of subs) {
      const m = /(\d+)\s*help/.exec(text);
      if (!m?.[1]) throw new Error(`英文侧屏态小字里没有「N help」了：${text} ⇒ 本锁随之失效，按新读法重写`);
      expect(Number(m[1])).toBeLessThanOrEqual(HELP_PER_MATCH);
    }
  });
});

describe('落地页页脚的公开入口（2026-09-23 批次 E＝C1 词条目录；2026-09-24 批次 G-3 加 C8 更新记录）', () => {
  it('★ 两语侧各两条：地址都带 .html，英文侧都如实写明只有中文', () => {
    // 默认态（localStorage 空 + nav=en-US）即英文侧，见上面的 beforeEach
    const en = render(<Landing onAuthed={() => undefined} />);
    const enLinks = [...en.container.querySelectorAll<HTMLAnchorElement>('.landing-foot a')];
    expect(enLinks.map((a) => a.textContent)).toEqual([FOOT_TERMS.en, FOOT_CHANGELOG.en]);
    // ★ 词条页与更新页目前都只有中文一套（SEO-SPEC §5 第 3 条），英文标签配中文页面＝承诺一个不存在的东西
    expect(enLinks[1]?.textContent).toBe('Changelog (Chinese only)');
    en.unmount();

    store('zh');
    const zh = render(<Landing onAuthed={() => undefined} />);
    const [terms, changelog] = [...zh.container.querySelectorAll<HTMLAnchorElement>('.landing-foot a')];
    expect(terms?.textContent).toBe('学习科学词条');
    // ★ `/terms/` 线上兜成 SPA 壳（09-23 实测 1487 字节、正文全空），一旦改回去就是指向空页
    expect(terms?.getAttribute('href')).toBe(CATALOG_PATH);
    expect(CATALOG_PATH).toBe('/terms/index.html');
    expect(changelog?.getAttribute('href')).toBe(CHANGELOG_PATH);
    // 站内跳刻意同标签页：新开等于把爬虫从首页走到公开页的那条路掐断
    expect(terms?.getAttribute('target')).toBeNull();
    expect(changelog?.getAttribute('target')).toBeNull();
  });
});
