/**
 * PkQuizBlock — 出题区（UX 批从 `PkMatch` 拆出，理由同 `PkAnswerBlock`）。
 *
 * ★ 按钮三种态的文案分工：「AI 出题中…」= 我在等生成（这次请求已发出）；
 *   「冷却中」= 60s CD 没过（不该让人点了才知道不能点）；
 *   两者都不成立才显示「出题」。三个态互斥，**不出现「冷却中」还能点的情况**。
 */
import { formatClock } from './pk-view';

interface Props {
  /** 本轮主题（出题必须贴合它） */
  topic: string;
  prompt: string;
  /** 出题 CD 剩余毫秒（>0 即冷却中） */
  cd: number;
  /** 生成在途 */
  busy: boolean;
  error: string;
  onPrompt: (v: string) => void;
  onSubmit: () => void;
}

export function PkQuizBlock({ topic, prompt, cd, busy, error, onPrompt, onSubmit }: Props) {
  return (
    <section className="sb-pk-card sb-pk-block">
      <div className="sb-pk-q-head">
        <span className="sb-pk-h2">出题给对手</span>
        {cd > 0 && <span className="sb-pk-deadline">冷却 {formatClock(cd)}</span>}
      </div>
      <p className="sb-pk-hint">
        题目必须贴合本轮主题「{topic || '（待定）'}」，跑题会被裁判判失败；成功 +1（60s 冷却）
      </p>
      <form
        className="sb-pk-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <input
          className="sb-pk-input"
          placeholder="如：出一道关于浮力的题（≤300 字）"
          maxLength={300}
          value={prompt}
          onChange={(e) => onPrompt(e.target.value)}
        />
        <button type="submit" className="sb-pk-btn primary" disabled={busy || cd > 0 || !prompt.trim()}>
          {busy ? 'AI 出题中…' : cd > 0 ? '冷却中' : '出题'}
        </button>
      </form>
      {error && <div className="sb-pk-error">{error}</div>}
    </section>
  );
}
