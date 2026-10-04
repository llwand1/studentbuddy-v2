/**
 * ReadingSizeCard — 设置页「阅读字号」卡（契约 `docs/READING-SIZE-SPEC.md`）。
 *
 * ★ 点选即存即生效（同 WaitDrillCard / QuizImageCard）：字号这种所见即所得的东西，
 *   再放一个「保存」按钮只会制造「我改了吗」的疑问——点下去整页正文当场变大就是最好的反馈。
 * ★ 只有四档、没有自由输入框：自由输入会让人调出 9px 或 40px 这种把版面搞坏的值，
 *   而四档都是按像素网格试过的比例（见 `styles/reading.css`）。
 * ★ 卡片自己放一段**样例正文**：让人在点之前就看到效果，不用先关设置页去对话里看。
 *   样例套的是 `.chat-bubble` 这个真实类名 ⇒ 预览与真实对话走同一条缩放规则，不会出现预览骗人。
 */
import { useState } from 'react';
import { READING_SIZES, loadReadingSize, saveReadingSize } from '../../lib/reading-prefs';
import './settings.css';

export function ReadingSizeCard() {
  const [size, setSize] = useState(loadReadingSize);
  const current = READING_SIZES.find((o) => o.id === size);
  return (
    <section className="settings-sec">
      <h3>阅读字号</h3>
      <p className="settings-hint">
        只放大<b>要逐字读的两处</b>：对话正文与词条释义。导航、卡牌、知识大陆是固定网格的像素布局，
        跟着放大会撑破版面，所以维持原样。改完立刻生效，只记在这台设备上。
      </p>
      <div className="quiz-mix-presets">
        {READING_SIZES.map((o) => (
          <button
            key={o.id}
            type="button"
            className={size === o.id ? 'quiz-mix-chip active' : 'quiz-mix-chip'}
            aria-pressed={size === o.id}
            onClick={() => setSize(saveReadingSize(o.id))}
          >
            {o.label}
            <span className="settings-hint"> {o.px}px</span>
          </button>
        ))}
      </div>
      {/* 预览用真实的 .chat-bubble 类：预览与对话走同一条规则，不存在「预览好看、实际两样」 */}
      <div className="chat-bubble md" data-testid="reading-size-preview">
        这是一段样例正文，用来预览当前字号。标题、代码与表格会按同一比例跟着变化。
      </div>
      <p className="settings-hint">
        当前：{current?.label ?? '标准'}（正文 {current?.px ?? 14}px）。手机端另有 12px 下限保护，不会被缩到更小。
      </p>
    </section>
  );
}
