/**
 * app/Landing — 未登录的**产品落地页**（2026-09-19 上线批；同日扩容批；2026-09-20 hero 重构批）。
 *
 * ★ 本批（2026-09-20 hero 重构）解决老板提的三件事：
 *   ① 「hero 太简陋、没体现项目特色」⇒ hero 从**居中单栏文字**改成**左文案 + 右侧实时演示**双栏，
 *      首屏就能看到产品在动，而不是读一段自我介绍。
 *   ② 「核心功能没说白——词条才是核心」⇒ 新增「一个词条走完一整套学习流程」段（`TermJourney`），
 *      并把原先排在第 2 位的「五环闭环」**降到词条之后**：五环是**结果**，词条才是**机制**
 *      （这五环全都是围绕词条转的），先讲机制再讲全景才不会把重点讲反。
 *   ③ 「要过程式演示动画」⇒ 新 `demo/` 目录（注册表 + 播放器 + 演示视图），全部前端写死，
 *      动画一律 CSS（AGENTS.md「刻意不引库」）。
 *
 * ★ 定位：门面，不是功能页——它回答「这是什么、对我有什么用、怎么开始」，然后才放人进去。
 *   已登录用户（main.tsx 经 /api/auth/me 判定）直接进应用壳，**永远看不到本页**。
 *
 * ★ 注册/登录表单**复用侧栏的 `AccountBox`（standalone 模式）**，不在本页复制一份表单逻辑：
 *   两处各写一遍必然漂成两种行为（同 RefList / ReviewPanel 的先例）。两条 CTA 通过 `key` 重挂
 *   切换初始模式——AccountBox 的模式是内部状态，重挂是最直白的传达。
 *   ★ 本批把登录卡从 hero **内部**移到 hero **下方**：hero 变双栏后，卡挤在左栏会把
 *   演示窗顶出首屏，且窄屏堆叠时卡的插入位置会变得不可预期。
 *
 * ★ 视觉纪律（AGENTS.md）：禁 emoji，图标全部用 `components/icons.tsx` 的自绘 line-icon；
 *   配色只取 tokens.css 的既有 token（#007aff 主色 / #fafafa 底），不另起色板。
 */
import { useEffect, useState } from 'react';
import type { AuthProviders, AuthUser } from '@sb/shared';
import { AccountBox } from '../components/AccountBox';
import { GithubLoginButton } from '../components/GithubLoginButton';
import { Mascot } from '../features/chat/Mascot';
import { LandingDemo } from './demo/LandingDemo';
import { TermJourney } from './TermJourney';
import {
  ChatIcon,
  QuizIcon,
  StatsIcon,
  CardsIcon,
  CheckIcon,
  FlowIcon,
  GraphIcon,
  VsIcon,
  NoteIcon,
  SearchIcon,
  DocIcon,
} from '../components/icons';
import './landing.css';

type AuthCard = 'closed' | 'register' | 'login';

/** 五环闭环（README「这是什么」）：产品的核心故事，一屏讲清它不是聊天框 */
const LOOP: Array<{ icon: typeof ChatIcon; step: string; title: string; desc: string }> = [
  { icon: ChatIcon, step: '学', title: '对话讲解', desc: '流式对话 + 思考链 + 联网检索 + 长文档检索注入' },
  { icon: QuizIcon, step: '练', title: '出题练习', desc: '自建出题引擎，四题型配比、自动判分、AI 配图' },
  { icon: StatsIcon, step: '析', title: '薄弱分析', desc: '逐题正确率统计、薄弱点定位、学习趋势' },
  { icon: CardsIcon, step: '忆', title: '记忆沉淀', desc: 'AI 词条库 + 艾宾浩斯复习时钟 + 跨会话长期记忆' },
  { icon: CheckIcon, step: '反馈', title: '反馈激励', desc: 'XP 连签、今日总结、AI 主动督促' },
];

/** 功能九宫格（README「功能总览」精选九条，覆盖全部一级功能入口） */
const FEATURES: Array<{ icon: typeof QuizIcon; title: string; desc: string }> = [
  { icon: FlowIcon, title: '学习流编排', desc: '把「讲解 → 出题 → 判分 → 复盘」拖成一条自己的学习流水线，预制模板开箱即用' },
  { icon: GraphIcon, title: '知识图谱', desc: '学过的概念自动连成图，点任一节点看它的邻里关系，薄弱环节一眼可见' },
  { icon: QuizIcon, title: '智能出题', desc: '题型配比可配、AI 特化 SVG 配图、五级解析阶梯——模型犯错不塌整组' },
  // 本批替换「艾宾浩斯复习」：复习已在 TermJourney 第 4 步讲得更透，此处让位给
  // 最独特、原先**在落地页完全没有出现**的那条交互（正文词条高亮 + 悬浮卡）
  { icon: CardsIcon, title: '词条高亮', desc: '回复里命中词条库的词自动标出：首现实线、复现虚点线，悬停即看释义与复习状态' },
  { icon: SearchIcon, title: '联网检索', desc: '三家搜索按 key 并行聚合 + 免 key 兜底，出网带 SSRF 护栏' },
  { icon: DocIcon, title: '文档模式', desc: '绑定长资料走 BM25 检索注入，带段号可溯源，70 万字资料也能对答' },
  { icon: VsIcon, title: 'AI 对战', desc: '和 AI 出题官双人对战答题，移动优先的独立页面' },
  { icon: NoteIcon, title: '笔记与总结', desc: '提交答案即落结构化笔记草稿，每日学习总结自动生成' },
  { icon: StatsIcon, title: '长期记忆', desc: '会话内先摘要再丢弃 + 跨会话画像恒注入，越用越懂你' },
];

/** 工程上较真（README「核心优势」精选四条，给懂行的人看的底牌） */
const ENGINEERING: Array<{ title: string; desc: string }> = [
  { title: 'AI 输出可靠性工程', desc: '解析五级阶梯、丢图保题、流式空闲超时、两层并发闸门——每条对策都对应一次真实故障的根因登记' },
  { title: '前端零第三方库', desc: '无 UI 库、无 Markdown 库、无图表库：解析、高亮、图表、本页的演示动画全部自绘——供应链攻击面与包体积同时趋零' },
  { title: '模型产出敢真跑', desc: '模型生成的网页在 CSP sandbox + iframe 双层沙箱里运行，页面源为 null，读不到应用数据' },
  { title: '不锁定供应商', desc: 'OpenAI 兼容 + Anthropic 双适配，搜索三家聚合——换模型、换服务商只动设置页' },
];

/** 隐私与数据（README「安全与隐私设计」）：对上线的用户来说这是决策项不是装饰 */
const PRIVACY: string[] = [
  '数据存你自己的服务器（SQLite 单文件），备份就是拷一个目录',
  '模型 API Key 加密入库、永不出接口；会话令牌只存哈希，拖库不可用',
  '登录态 HttpOnly cookie + 强制鉴权；口令 scrypt 派生、参数自描述',
  '跨用户数据互相不可见，写操作校验 Origin，外部结果永不直接写库',
];

export function Landing({ onAuthed }: { onAuthed: (u: AuthUser) => void }) {
  const [card, setCard] = useState<AuthCard>('closed');
  // GitHub 登录入口是否可用（契约 AUTH-SPEC §2.8）：服务端没配凭据就不画按钮，
  // 请求失败（非 2xx / 网络）按「不可用」处理——宁少一个入口，不给用户一个点了报错的按钮
  const [githubEnabled, setGithubEnabled] = useState(false);
  useEffect(() => {
    fetch('/api/auth/providers')
      .then((r) => (r.ok ? (r.json() as Promise<{ providers: AuthProviders }>) : null))
      .then((d) => setGithubEnabled(Boolean(d?.providers.github)))
      .catch(() => setGithubEnabled(false));
  }, []);

  return (
    <div className="landing">
      <header className="landing-top">
        <span className="landing-brand">
          <Mascot />
          <span className="landing-brand-name">studentbuddy</span>
        </span>
        <div className="landing-top-right">
          <a className="landing-ghost landing-gh" href="https://github.com/llwand1/studentbuddy-v2" target="_blank" rel="noreferrer noopener">
            GitHub
          </a>
          {githubEnabled && <GithubLoginButton className="landing-ghost" label="GitHub 登录" />}
          <button type="button" className="landing-ghost" onClick={() => setCard(card === 'login' ? 'closed' : 'login')}>
            登录
          </button>
        </div>
      </header>

      <main className="landing-body">
        <section className="landing-hero">
          <div className="landing-hero-copy">
            <h1 className="landing-title">
              学过的词，会<span className="landing-accent">自己留下来</span>
            </h1>
            <p className="landing-sub">
              对话里自动抽词入库，下次对话优先被想起，到期自动排队复习——同一套词条贯穿讲解、出题、复习与总结。
              自己的模型 Key，数据只在自己手里。
            </p>
            <div className="landing-cta-row">
              <button type="button" className="landing-cta" onClick={() => setCard(card === 'register' ? 'closed' : 'register')}>
                开始使用
              </button>
              <span className="landing-cta-note">邮箱注册，一分钟开始</span>
            </div>
            {/* 首屏数据：★ 数字必须与实测一致——`node tools/metrics.mjs` 是唯一事实源。
                2026-09-20 知识图演示批顺手校准：此前写「2000+ 自动化测试 / 127 个 REST 接口」，
                实测已是 2339 / 140。★ 127 这种**精确的旧值**比模糊表述更危险——它看起来像真的，
                而且首屏是访客第一眼看到的地方（README 徽章有 metrics --check 守着，这里没有）。 */}
            <div className="landing-stats" aria-label="项目数据">
              <span>2300+ 自动化测试</span>
              <span>6 个运行时依赖</span>
              <span>140 个 REST 接口</span>
              <span>0 个第三方 UI 库</span>
            </div>
          </div>
          <div className="landing-hero-demo">
            <LandingDemo />
          </div>
        </section>

        {card !== 'closed' && (
          <div className="landing-auth-card">
            <AccountBox key={card} standalone initialMode={card} onAuthChange={(u) => u && onAuthed(u)} />
            {githubEnabled && (
              <div className="landing-auth-github">
                <span className="landing-auth-github-or">或</span>
                <GithubLoginButton className="landing-github-btn" label="使用 GitHub 登录" />
                <span className="landing-github-hint">GitHub 已验证邮箱与本站账号相同时，直接登入原账号</span>
              </div>
            )}
          </div>
        )}

        {/* GitHub 横幅（老板 2026-09-19：项目地址放显眼位置 + 本地安装包版引导） */}
        <section className="landing-github" aria-label="开源仓库与本地版">
          <div className="landing-github-main">
            <span className="landing-github-title">本项目完全开源</span>
            <a
              className="landing-github-link"
              href="https://github.com/llwand1/studentbuddy-v2"
              target="_blank"
              rel="noreferrer noopener"
            >
              github.com/llwand1/studentbuddy-v2
            </a>
          </div>
          <a
            className="landing-github-note"
            href="https://github.com/llwand1/studentbuddy-v2#快速开始"
            target="_blank"
            rel="noreferrer noopener"
          >
            更加完整的体验在<b>本地安装包版</b>，欢迎体验 →
          </a>
        </section>

        {/* 词条旅程：核心机制，排在五环之前（先讲机制、再讲全景） */}
        <TermJourney />

        <section className="landing-section" aria-label="五环闭环">
          <h2 className="landing-h2">
            而它们串起来，是一条自动运转的<span className="landing-accent">学习闭环</span>
          </h2>
          <p className="landing-section-sub">学 → 练 → 析 → 忆 → 反馈，五环相扣：学过的自动出题练、错的自动进复习、复习的自动记趋势</p>
          <div className="landing-loop">
            {LOOP.map(({ icon: Icon, step, title, desc }, i) => (
              <div className="landing-loop-card" key={step}>
                <div className="landing-loop-head">
                  <span className="landing-loop-icon">
                    <Icon size={18} />
                  </span>
                  <span className="landing-loop-step">{step}</span>
                  {i < LOOP.length - 1 && <span className="landing-loop-arrow">→</span>}
                </div>
                <h3 className="landing-feature-title">{title}</h3>
                <p className="landing-feature-desc">{desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="landing-section" aria-label="功能亮点">
          <h2 className="landing-h2">
            一套<span className="landing-accent">完整的工具箱</span>
          </h2>
          <p className="landing-section-sub">每一个功能都是一级入口，不是聊天框里的附属技巧</p>
          <div className="landing-features">
            {FEATURES.map(({ icon: Icon, title, desc }) => (
              <div className="landing-feature" key={title}>
                <span className="landing-feature-icon">
                  <Icon size={20} />
                </span>
                <h3 className="landing-feature-title">{title}</h3>
                <p className="landing-feature-desc">{desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="landing-section" aria-label="工程品质">
          <h2 className="landing-h2">
            工程上<span className="landing-accent">较真</span>
          </h2>
          <p className="landing-section-sub">差别不在于有没有接大模型，而在于闭环完整度、AI 输出可靠性、工程质量三层是否同时做实</p>
          <div className="landing-eng">
            {ENGINEERING.map(({ title, desc }) => (
              <div className="landing-eng-card" key={title}>
                <h3 className="landing-feature-title">{title}</h3>
                <p className="landing-feature-desc">{desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="landing-section landing-privacy" aria-label="隐私与数据">
          <div>
            <h2 className="landing-h2">
              隐私与<span className="landing-accent">数据自持</span>
            </h2>
            <ul className="landing-privacy-list">
              {PRIVACY.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
          <div className="landing-privacy-cta">
            <p className="landing-privacy-title">一分钟开始</p>
            <button
              type="button"
              className="landing-cta"
              onClick={() => {
                setCard('register');
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            >
              免费注册
            </button>
          </div>
        </section>

        <section className="landing-steps" aria-label="开始步骤">
          <div className="landing-step">
            <span className="landing-step-num">1</span>邮箱注册账号
          </div>
          <div className="landing-step">
            <span className="landing-step-num">2</span>设置页绑定自己的模型 Key
          </div>
          <div className="landing-step">
            <span className="landing-step-num">3</span>提问、出题、复习，闭环开始转
          </div>
        </section>
      </main>

      <footer className="landing-foot">本地优先 · 数据自持 · © 2026 studentbuddy</footer>
    </div>
  );
}
