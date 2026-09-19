/**
 * app/Landing — 未登录的**产品落地页**（2026-09-19 上线批，老板反馈原话：
 * 「一个产品一般不是直接开始使用的，应该是先有介绍等内容，点击开始使用才能开始」）。
 *
 * ★ 定位：门面，不是功能页——它回答「这是什么、对我有什么用、怎么开始」，然后才放人进去。
 *   已登录用户（main.tsx 经 /api/auth/me 判定）直接进应用壳，**永远看不到本页**；
 *   未登录用户打开域名先落在这里，点「开始使用」/「登录」才展开注册/登录卡。
 *
 * ★ 注册/登录表单**复用侧栏的 `AccountBox`（standalone 模式）**，不在本页复制一份表单逻辑：
 *   两处各写一遍必然漂成两种行为（同 RefList / ReviewPanel 的先例）。注册/登录两条 CTA
 *   通过 `key={authCard}` 重挂切换初始模式——AccountBox 的模式是内部状态，重挂是最直白的传达。
 *
 * ★ 视觉纪律（AGENTS.md）：禁 emoji，图标全部用 `components/icons.tsx` 的自绘 line-icon；
 *   配色只取 tokens.css 的既有 token（#007aff 主色 / #fafafa 底），不另起色板。
 */
import { useState } from 'react';
import type { AuthUser } from '@sb/shared';
import { AccountBox } from '../components/AccountBox';
import { Mascot } from '../features/chat/Mascot';
import { FlowIcon, GraphIcon, QuizIcon, VsIcon, NoteIcon, ClockIcon } from '../components/icons';
import './landing.css';

type AuthCard = 'closed' | 'register' | 'login';

const FEATURES: Array<{ icon: typeof QuizIcon; title: string; desc: string }> = [
  { icon: FlowIcon, title: '学习流编排', desc: '把「讲解 → 出题 → 判分 → 复盘」拖成一条自己的学习流水线' },
  { icon: GraphIcon, title: '知识图谱', desc: '学过的概念自动连成图，薄弱环节一眼可见' },
  { icon: QuizIcon, title: '智能出题', desc: '按题型配比出题、联网取材、逐题统计与薄弱点分析' },
  { icon: ClockIcon, title: '艾宾浩斯复习', desc: '词条库自带复习时钟，到期自动排队，忘了就归零重来' },
  { icon: VsIcon, title: 'AI 对战', desc: '和 AI 出题官双人对战答题，比谁先答对' },
  { icon: NoteIcon, title: '笔记与总结', desc: '刷题笔记自动沉淀，每日学习总结自动生成' },
];

export function Landing({ onAuthed }: { onAuthed: (u: AuthUser) => void }) {
  const [card, setCard] = useState<AuthCard>('closed');

  return (
    <div className="landing">
      <header className="landing-top">
        <span className="landing-brand">
          <Mascot />
          <span className="landing-brand-name">studentbuddy</span>
        </span>
        <button type="button" className="landing-ghost" onClick={() => setCard(card === 'login' ? 'closed' : 'login')}>
          登录
        </button>
      </header>

      <main className="landing-body">
        <section className="landing-hero">
          <h1 className="landing-title">你的专属学习助手</h1>
          <p className="landing-sub">
            对话讲解、智能出题、遗忘曲线复习、学习流编排——
            围绕「学 → 练 → 复盘」的完整闭环，自己的模型 Key，数据只在自己手里。
          </p>
          <div className="landing-cta-row">
            <button
              type="button"
              className="landing-cta"
              onClick={() => setCard(card === 'register' ? 'closed' : 'register')}
            >
              开始使用
            </button>
            <span className="landing-cta-note">邮箱注册，一分钟开始</span>
          </div>
          {card !== 'closed' && (
            <div className="landing-auth-card">
              {/* key 重挂切换初始模式：AccountBox 的模式是内部状态，这是最直白的传达方式 */}
              <AccountBox key={card} standalone initialMode={card} onAuthChange={(u) => u && onAuthed(u)} />
            </div>
          )}
        </section>

        <section className="landing-features" aria-label="功能亮点">
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div className="landing-feature" key={title}>
              <span className="landing-feature-icon">
                <Icon size={20} />
              </span>
              <h2 className="landing-feature-title">{title}</h2>
              <p className="landing-feature-desc">{desc}</p>
            </div>
          ))}
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
