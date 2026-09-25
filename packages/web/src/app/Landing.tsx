/**
 * app/Landing — 未登录的**产品落地页**（2026-09-19 上线批；09-20 hero 重构批；09-21 双屏批；2026-09-22 重排批；2026-09-22 中英切换批）。
 *
 * ★ 本批（2026-09-22 重排）只解决老板提的一件事：**「雷点是先搞了功能介绍，而不是产品介绍」**。
 *   做法是按 T3「演示开道」版式（Linear/Vercel 一路：hero 轻量 + 演示窗说主话），
 *   并在 hero 之后**立刻**补一整段产品整体介绍（`LandingIntro`），然后才许进功能区（`LandingFeatures`）。
 *
 *   ★★★ **本文件唯一的硬顺序约束**（改任何别的都可以，这条不许松）：
 *   **`LandingIntro` 必须排在 `LandingFeatures` 之前，且中间不许夹别的 section。**
 *   它由 `Landing.test.tsx` 的「介绍段排在功能区之前」机器锁住——因为这条顺序塌回去时
 *   **没有任何东西会报错**：文案不红、只测「文本在不在」的用例全绿、只有读者会觉得这页在自说自话。
 *   2026-09-22 之前的版本正是如此：hero 一格讲完全部介绍（而且那一格还塞了 4 个 feature 从句），
 *   从第 3 屏往下全是功能。
 *
 * ★ 「词条是主体」落到两个地方，缺一不可（2026-09-22 二次点单后重排）：
 *   ① hero 的标题本身就是讲词条（「学过的词，会自己留下来」）；
 *   ② `LandingIntro` 的**第二段**整段专讲「一切都以词条为主体」。
 *   ★ 它**不出现在第一段的定义句里**：定义句只负责回答"这属于哪一类东西"，
 *     机制留给紧随其后的词条段——读者还没搞清这是什么时先听一个内部概念，等于没讲。
 *   ★ 功能区也随之从「并列九宫格」改成**一条编了号的动线**（01 学 → 05 反馈）：
 *     老板二次点单原话是「接下来的功能一步步讲」。
 *
 * ★ 2026-09-22（中英切换批）：文案全部出本文件（`landing-copy.ts` / `landing-data.ts`，
 *   均为 `Bi={zh,en}` 成对），语言态由 `LandingLangProvider` 罩住整棵树，页眉 `LangToggle` 切换。
 *   **只罩落地页**——登录后应用壳仍是中文（范围决策见 `landing-lang.tsx` 头注）。
 *
 * ★ 定位不变：门面，不是功能页。已登录用户直接进应用壳，**永远看不到本页**。
 *
 * ★ 注册/登录表单复用侧栏的 `AccountBox`（standalone 模式），不在本页复制一份表单逻辑：
 *   两处各写一遍必然漂成两种行为（同 RefList / ReviewPanel 的先例）。两条 CTA 通过 `key` 重挂
 *   切换初始模式——AccountBox 的模式是内部状态，重挂是最直白的传达。
 *   ★ 表单**本体**（AccountBox 的字段/按钮）不在本批双语范围内——它是登录后的同一块牌子。
 *
 * ★ 视觉纪律（AGENTS.md）：禁 emoji，图标用 `components/icons.tsx` 的自绘 line-icon；
 *   配色只取 tokens.css 既有 token（#007aff 主色 / #fafafa 底），不另起色板；禁内联 style。
 */
import { useEffect, useState } from 'react';
import type { AuthUser } from '@sb/shared';
import { api } from '../lib/api';
import { AccountBox } from '../components/AccountBox';
import { DemoLoginButton } from '../components/DemoLoginButton';
import { GithubLoginButton } from '../components/GithubLoginButton';
import { LandingBrand } from './LandingBrand';
import { LandingDemo } from './demo/LandingDemo';
import { LandingIntro } from './LandingIntro';
import { LandingFeatures } from './LandingFeatures';
import { PRIVACY_ITEMS } from './landing-data';
import { AUTH, FOOT, FOOT_CHANGELOG, FOOT_TERMS, GITHUB_BAND, HERO, PRIVACY, STATS, STEPS, TOP } from './landing-copy';
import { LangToggle, LandingLangProvider, useLandingLang } from './landing-lang';
import { CATALOG_PATH, CHANGELOG_PATH } from '../seo/paths';
import './landing.css';

type AuthCard = 'closed' | 'register' | 'login';

export function Landing(props: { onAuthed: (u: AuthUser) => void }) {
  return (
    <LandingLangProvider>
      <LandingPage {...props} />
    </LandingLangProvider>
  );
}

function LandingPage({ onAuthed }: { onAuthed: (u: AuthUser) => void }) {
  const { lang } = useLandingLang();
  const [card, setCard] = useState<AuthCard>('closed');
  // GitHub 登录入口是否可用（契约 AUTH-SPEC §2.8）：服务端没配凭据就不画按钮，
  // 请求失败（非 2xx / 网络）按「不可用」处理——宁少一个入口，不给用户一个点了报错的按钮。
  // ★ `demo`（§2.10 公用体验账号）同口径：开关在上游。两者共用**一次** providers 请求，
  //   不各拉一遍——两个独立请求会让两个入口的可用性在短暂的时间窗里不一致，
  //   表现出来就是「GitHub 按钮先出现、体验按钮后弹出」这种没人能复现的抖动。
  const [githubEnabled, setGithubEnabled] = useState(false);
  const [demoEnabled, setDemoEnabled] = useState(false);
  useEffect(() => {
    // ★ 走 `api` 而不是裸 `fetch`：这条请求正是服务端 `app_open` 的采集点（GROWTH-SPEC §2.1），
    //   而归因头 `X-SB-Ref` 由 `lib/api-request.ts` 那一层统一注入。裸 fetch 绕过那层
    //   ＝**全站最关键的一个计数拿不到来源**（2026-09-24 归因批就是为它而开）。
    api.auth
      .surface()
      .then((d) => {
        setGithubEnabled(Boolean(d.providers.github));
        setDemoEnabled(Boolean(d.providers.demo));
      })
      .catch(() => {
        setGithubEnabled(false);
        setDemoEnabled(false);
      });
  }, []);

  return (
    <div className="landing">
      <header className="landing-top">
        <LandingBrand />
        <div className="landing-top-right">
          <LangToggle />
          <a className="landing-ghost landing-gh" href="https://github.com/llwand1/studentbuddy-v2" target="_blank" rel="noreferrer noopener">
            GitHub
          </a>
          {githubEnabled && <GithubLoginButton className="landing-ghost" label={TOP.ghLogin[lang]} />}
          <button type="button" className="landing-ghost" onClick={() => setCard(card === 'login' ? 'closed' : 'login')}>
            {TOP.login[lang]}
          </button>
        </div>
      </header>

      <main className="landing-body">
        {/* ① hero：按 T3 只留三样——标题、一句话、CTA。演示窗是这一屏的主角。
            原先那句塞了 4 个 feature 从句的副标已全部下放到 `LandingIntro` / `LandingFeatures`。 */}
        <section className="landing-hero">
          <div className="landing-hero-copy">
            <h1 className="landing-title">
              {HERO.titlePre[lang]}
              <span className="landing-accent">{HERO.titleAccent[lang]}</span>
            </h1>
            <p className="landing-sub">{HERO.sub[lang]}</p>
            <div className="landing-cta-row">
              <button type="button" className="landing-cta" onClick={() => setCard(card === 'register' ? 'closed' : 'register')}>
                {HERO.cta[lang]}
              </button>
              <span className="landing-cta-note">{HERO.ctaNote[lang]}</span>
            </div>
            {/* 公用体验入口（§2.10）：与上面的注册 CTA 并列，警示语必须读得到——
                公用池里所有访客的数据互相可见，不明示等于默许隐私事故 */}
            {demoEnabled && (
              <div className="landing-demo-row">
                <DemoLoginButton onAuthed={onAuthed} />
              </div>
            )}
            {/* 首屏数据：★ 数字必须与实测一致——`node tools/metrics.mjs` 是唯一事实源。
                2026-09-22 重排批把「数据条」降级为 hero 底部的信任信号，不再是介绍正文
                （介绍改由 `LandingIntro` 承担，详见该文件头注）。
                ★ 精确的旧值比模糊表述更危险——它看起来像真的，而首屏是访客第一眼看到的地方
                （README 徽章有 metrics --check 守着，这里没有）。★ 双语批：两列同数，换语言不换账。 */}
            <div className="landing-stats" aria-label={HERO.statsAria[lang]}>
              {STATS.map((s) => (
                <span key={s.label.en}>
                  {s.n} {s.label[lang]}
                </span>
              ))}
            </div>
          </div>
          <div className="landing-hero-demo">
            <LandingDemo />
          </div>
        </section>

        {/* ② 注册/登录卡：贴着 CTA 展开（它是 hero 的延伸，不占内容序列的位置） */}
        {card !== 'closed' && (
          <div className="landing-auth-card">
            <AccountBox key={card} standalone initialMode={card} onAuthChange={(u) => u && onAuthed(u)} />
            {githubEnabled && (
              <div className="landing-auth-github">
                <span className="landing-auth-github-or">{AUTH.or[lang]}</span>
                <GithubLoginButton className="landing-github-btn" label={AUTH.ghBtn[lang]} />
                {/* ★ 2026-09-21（独立建号批）文案改写：原文案描述的正是**已废弃的归并口径**，
                    与新行为正好相反。不改就是明着误导用户 */}
                <span className="landing-github-hint">{AUTH.ghHint[lang]}</span>
              </div>
            )}
          </div>
        )}

        {/* ③ 产品整体介绍 —— 必须紧跟 hero、且在功能区之前（见文件头注的硬顺序约束） */}
        <LandingIntro />

        {/* ④ 功能介绍 */}
        <LandingFeatures />

        {/* GitHub 横幅 —— ★ 2026-09-22 重排：它原先排在 hero 之后第二位，正好插在
            「这是什么」和「它演示了什么」中间，把介绍节奏拦腰砍断。此处移到功能区之后、
            隐私之前：那时读者已经看完产品，正是「去哪拿源码」这个念头冒出来的时候。 */}
        <section className="landing-github" aria-label={GITHUB_BAND.aria[lang]}>
          <div className="landing-github-main">
            <span className="landing-github-title">{GITHUB_BAND.title[lang]}</span>
            <a
              className="landing-github-link"
              href="https://github.com/llwand1/studentbuddy-v2"
              target="_blank"
              rel="noreferrer noopener"
            >
              github.com/llwand1/studentbuddy-v2
            </a>
          </div>
          {/* ★ 锚点 `#快速开始` 两语同值：README 只有中文标题，EN 侧跟着跳同一节（已知代价） */}
          <a
            className="landing-github-note"
            href="https://github.com/llwand1/studentbuddy-v2#快速开始"
            target="_blank"
            rel="noreferrer noopener"
          >
            {GITHUB_BAND.notePre[lang]}
            <b>{GITHUB_BAND.noteMid[lang]}</b>
            {GITHUB_BAND.noteTail[lang]}
          </a>
        </section>

        <section className="landing-section landing-privacy" aria-label={PRIVACY.aria[lang]}>
          <div>
            <h2 className="landing-h2">
              {PRIVACY.h2Pre[lang]}
              <span className="landing-accent">{PRIVACY.h2Mid[lang]}</span>
            </h2>
            <ul className="landing-privacy-list">
              {PRIVACY_ITEMS.map((t) => (
                <li key={t.en}>{t[lang]}</li>
              ))}
            </ul>
          </div>
          <div className="landing-privacy-cta">
            <p className="landing-privacy-title">{PRIVACY.ctaTitle[lang]}</p>
            <button
              type="button"
              className="landing-cta"
              onClick={() => {
                setCard('register');
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            >
              {PRIVACY.cta[lang]}
            </button>
          </div>
        </section>

        <section className="landing-steps" aria-label={STEPS.aria[lang]}>
          {STEPS.items.map((s, i) => (
            <div className="landing-step" key={s.en}>
              <span className="landing-step-num">{i + 1}</span>
              {s[lang]}
            </div>
          ))}
        </section>
      </main>

      <footer className="landing-foot">
        {FOOT[lang]} ·{' '}
        {/* ★ 站内链接、同标签页：这是爬虫从首页走到词条页的那条路，新开标签等于把它掐掉 */}
        <a href={CATALOG_PATH}>{FOOT_TERMS[lang]}</a> ·{' '}
        {/* ★ 更新页是从公开字节里长出来的静态页（渠道台账 C8），同一条爬虫路径规矩 */}
        <a href={CHANGELOG_PATH}>{FOOT_CHANGELOG[lang]}</a>
      </footer>
    </div>
  );
}
