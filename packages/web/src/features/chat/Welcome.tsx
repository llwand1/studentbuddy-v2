/**
 * Welcome — 空会话欢迎页（「没选会话」与「新会话还没消息」共用这一套）。
 * 问候 + 学习四环建议卡：点一张**直接开聊**——提示语作为第一问发出去，没会话先开一间
 * （CHAT-UX §2.9；改版前只填进输入框，新用户还要再点一次发送、或先去侧栏「新建对话」）。
 * ★ 所以四句提示语必须**自足**：它们永远是一段新对话的第一句，不能写「刚才的主题」这种指望上文的话；
 *   拿不准用户在学什么的，让 AI 先问一句，而不是猜。
 * 入场动画是逐张上浮淡入，延迟写在 CSS 的 nth-child 上（门禁禁内联 style）。
 */
import { CardsIcon, ChatIcon, QuizIcon, StatsIcon } from '../../components/icons';
import { PixelScene } from './PixelScene';
import { useExamScope } from '../exam/useExamScope';

const CARDS: Array<{ icon: typeof ChatIcon; ring: string; title: string; prompt: string }> = [
  { icon: ChatIcon, ring: '学', title: '问个概念', prompt: '用一句话讲清楚什么是向量数据库，再举一个学习场景里的例子' },
  { icon: QuizIcon, ring: '练', title: '出一套题', prompt: '围绕我最近在学的内容出 3 道单选题，附答案与解析；不知道我在学什么就先问我' },
  { icon: CardsIcon, ring: '忆', title: '记住术语', prompt: '帮我把一个主题的核心术语整理成词条记进词条库，以后回答时优先使用这些术语；先问我想记哪个主题' },
  { icon: StatsIcon, ring: '反馈', title: '看看进度', prompt: '总结一下我最近的学习情况，指出薄弱环节' },
];

/**
 * 应试模式下的四句提示语（按环取，缺环回落到通用那句）。
 * ★ 通用那几句写着「不知道我在学什么就先问我」——开着应试模式时范围已经说清楚了，
 *   再让 AI 反问一句就是没接住用户已经做过的选择（契约 EXAM-MODE-SPEC §11）。
 */
const examPrompts = (summary: string): Record<string, string> => ({
  学: `讲讲${summary}范围内的一个高频考点，先说它常怎么考，再举一例`,
  练: `围绕${summary}出 3 道单选题，附答案与解析，只出这个范围内会考的考法`,
  忆: `把${summary}的核心术语整理成词条记进我的词条库，以后回答时优先使用这些术语`,
  反馈: `总结一下我在${summary}范围内的学习情况，指出还没练到的薄弱处`,
});

export function Welcome({ onPick }: { onPick: (text: string) => void }) {
  const exam = useExamScope();
  const prompts = exam.on && exam.summary ? examPrompts(exam.summary) : null;
  return (
    <div className="welcome">
      <p className="welcome-eyebrow">CAMPFIRE · 篝火营地</p>
      <PixelScene />
      <p className="welcome-hi">今天想学点什么？</p>
      <p className="welcome-sub">
        {prompts
          ? `应试模式开着，范围＝${exam.summary}。点一张卡直接开聊，四句话都只问这个范围内的事。`
          : '学 → 练 → 析 → 忆 → 反馈。点一张卡直接开聊，或者在下面的输入框里直接问。'}
      </p>
      <div className="welcome-grid">
        {CARDS.map(({ icon: Icon, ring, title, prompt }) => (
          <button key={title} className="welcome-card" onClick={() => onPick(prompts?.[ring] ?? prompt)}>
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
