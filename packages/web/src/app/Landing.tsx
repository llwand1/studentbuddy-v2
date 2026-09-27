/**
 * app/Landing — 未登录的产品落地页（2026-09-19 上线 … 2026-09-28 冒险录大改）。
 *
 * ★ 2026-09-28 版式：整页是一本「冒险录」——
 *   序章（首屏，可交互横版战斗 `hero/LandingHero`）→ 第一章 知识大陆如何生长（俯视大陆 ⇄ 横版讨伐）
 *   → 第二章 词条（只留一段演示动画）→ 第三章 AI 学习伙伴 → 第四章 卡牌 → 第五章 Boss 战＝对战 → 终章。
 *   游戏化之前的功能清单、工程讲解、隐私长文全部下线：门面只做**游戏化玩法演示**。
 *   各章文案与事实口径见 `world/world-copy.ts` 头注。
 *
 * ★ 定位不变：门面，不是功能页。已登录用户直接进应用壳，永远看不到本页。
 * ★ 注册/登录表单复用侧栏的 `AccountBox`（standalone 模式），不在本页复制一份表单逻辑。
 * ★ 视觉纪律：禁 emoji；动效只用 steps()；禁内联 style（数据驱动处带 gates:style-ok）。
 */
import { useEffect, useRef, useState } from 'react';
import type { AuthUser } from '@sb/shared';
import { api } from '../lib/api';
import { AccountBox } from '../components/AccountBox';
import { DemoLoginButton } from '../components/DemoLoginButton';
import { GithubLoginButton } from '../components/GithubLoginButton';
import { LandingBrand } from './LandingBrand';
import { LandingHero } from './hero/LandingHero';
import { ChapterContinent } from './world/ChapterContinent';
import { ChapterTerm } from './world/ChapterTerm';
import { ChapterNpc } from './world/ChapterNpc';
import { ChapterCards } from './world/ChapterCards';
import { ChapterBoss } from './world/ChapterBoss';
import { ChapterFinale } from './world/ChapterFinale';
import { AUTH, FOOT, FOOT_CHANGELOG, FOOT_TERMS, HERO, HERO_TAGS, TOP } from './landing-copy';
import { LangToggle, LandingLangProvider, useLandingLang } from './landing-lang';
import { CATALOG_PATH, CHANGELOG_PATH } from '../seo/paths';
import { useLandingAtmos } from './useLandingAtmos';
import './landing.css';
import './landing-dark.css';
import './world/world.css';

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
  const rootRef = useRef<HTMLDivElement>(null);
  useLandingAtmos(rootRef);
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
    //   ＝**全站最关键的一个计数拿不到来源**（2026-09-24 就是为它而开）。
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
    <div className="landing" ref={rootRef} lang={lang === 'zh' ? 'zh-CN' : 'en'}>
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
        {/* ① hero：2026-09-28 升级为可交互暗黑像素序章「词条即力量」（`hero/LandingHero`）。
            标题/副标/CTA 仍由本文件给出（被测试锁住的门面文案），序章舞台包在外面。 */}
        <LandingHero>
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
            <div className="landing-stats" aria-label={HERO.statsAria[lang]}>
              {HERO_TAGS.map((s) => (
                <span key={s.en}>
                  {s[lang]}
                </span>
              ))}
            </div>
          </div>
        </LandingHero>

        {/* ② 注册/登录卡：贴着 CTA 展开（它是 hero 的延伸，不占内容序列的位置） */}
        {card !== 'closed' && (
          <div className="landing-auth-card">
            <AccountBox key={card} standalone initialMode={card} onAuthChange={(u) => u && onAuthed(u)} />
            {githubEnabled && (
              <div className="landing-auth-github">
                <span className="landing-auth-github-or">{AUTH.or[lang]}</span>
                <GithubLoginButton className="landing-github-btn" label={AUTH.ghBtn[lang]} />
                {/* ★ 2026-09-21（独立建号）文案改写：原文案描述的正是**已废弃的归并口径**，
                    与新行为正好相反。不改就是明着误导用户 */}
                <span className="landing-github-hint">{AUTH.ghHint[lang]}</span>
              </div>
            )}
          </div>
        )}

        {/* ③ 冒险录各章：只讲游戏化玩法 */}
        <ChapterContinent />
        <ChapterTerm />
        <ChapterNpc />
        <ChapterCards />
        <ChapterBoss />
        <ChapterFinale
          onCta={() => {
            setCard('register');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      </main>

      <footer className="landing-foot">
        {FOOT[lang]} ·{' '}
        {/* ★ 站内链接、同标签页：这是爬虫从首页走到词条页的那条路，新开标签等于把它掐掉 */}
        <a href={CATALOG_PATH}>{FOOT_TERMS[lang]}</a> ·{' '}
        {/* ★ 更新页是从公开字节里长出来的静态页，同一条爬虫路径规矩 */}
        <a href={CHANGELOG_PATH}>{FOOT_CHANGELOG[lang]}</a>
      </footer>
    </div>
  );
}
