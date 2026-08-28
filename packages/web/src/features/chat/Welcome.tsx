/**
 * Welcome — 空会话欢迎页（「没选会话」与「新会话还没消息」共用这一套）。
 * 问候 + 学习四环建议卡：点一张把提示语填进输入框（不直接发送，避免误触烧 token）。
 * 入场动画是逐张上浮淡入，延迟写在 CSS 的 nth-child 上（门禁禁内联 style）。
 */
import { CardsIcon, ChatIcon, QuizIcon, StatsIcon } from '../../components/icons';

const CARDS: Array<{ icon: typeof ChatIcon; ring: string; title: string; prompt: string }> = [
  { icon: ChatIcon, ring: '学', title: '问个概念', prompt: '用一句话讲清楚什么是向量数据库，再举一个学习场景里的例子' },
  { icon: QuizIcon, ring: '练', title: '出一套题', prompt: '围绕刚才的主题出 3 道单选题，附答案与解析' },
  { icon: CardsIcon, ring: '忆', title: '背几张卡', prompt: '把刚才的要点做成记忆卡片，安排到明天复习' },
  { icon: StatsIcon, ring: '反馈', title: '看看进度', prompt: '总结一下我最近的学习情况，指出薄弱环节' },
];

export function Welcome({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="welcome">
      <div className="welcome-glow" aria-hidden="true" />
      <p className="welcome-hi">今天想学点什么？</p>
      <p className="welcome-sub">学 → 练 → 析 → 忆 → 反馈。点一张卡先起个头，文字会填进输入框，你可以改。</p>
      <div className="welcome-grid">
        {CARDS.map(({ icon: Icon, ring, title, prompt }) => (
          <button key={title} className="welcome-card" onClick={() => onPick(prompt)}>
            <span className="welcome-card-top">
              <Icon size={18} />
              <span className="welcome-card-ring">{ring}</span>
            </span>
            <span className="welcome-card-title">{title}</span>
            <span className="welcome-card-prompt">{prompt}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
