/**
 * PkQuizBlock — 出题区（UX 批从 `PkMatch` 拆出，理由同 `PkAnswerBlock`）。
 *
 * ★ 按钮三种态的文案分工：「AI 出题中…」= 我在等生成（这次请求已发出）；
 *   「冷却中」= 60s CD 没过（不该让人点了才知道不能点）；
 *   两者都不成立才显示「出题」。三个态互斥，**不出现「冷却中」还能点的情况**。
 * §15 B2（2026-09-20 老板拍板「出题时现选」）：题型单选/判断当场挑，与设置页配比解耦。
 */
import type { PkQuizKind } from '@sb/shared';
import { formatClock } from './pk-view';
import { PkTermPicker, type PkTermOption } from './PkTermPicker';

/** 现选题型（与 shared `PkQuizKind` 同形；本地常量避免为两个字符串引类型入展示层之外再绕一手） */
const KINDS: { value: PkQuizKind; label: string }[] = [
  { value: 'single', label: '单选' },
  { value: 'judge', label: '判断' },
  { value: 'scenario', label: '情景' },
];

interface Props {
  /** 本轮主题（出题必须贴合它） */
  topic: string;
  prompt: string;
  /** 出题 CD 剩余毫秒（>0 即冷却中） */
  cd: number;
  /** 生成在途 */
  busy: boolean;
  error: string;
  /** 当前选中的题型（状态在 `PkMatch`，提交时随请求带走） */
  qKind: PkQuizKind;
  /** §15 B3 词条硬绑定：我的词条库快照 + 已选 id（状态在 `PkMatch`） */
  terms: PkTermOption[];
  termIds: string[];
  onTermIds: (ids: string[]) => void;
  onPrompt: (v: string) => void;
  onKind: (k: PkQuizKind) => void;
  onSubmit: () => void;
}

export function PkQuizBlock({ topic, prompt, cd, busy, error, qKind, terms, termIds, onTermIds, onPrompt, onKind, onSubmit }: Props) {
  return (
    <section className="sb-pk-card sb-pk-block">
      <div className="sb-pk-q-head">
        <span className="sb-pk-h2">出题给对手</span>
        {cd > 0 && <span className="sb-pk-deadline">冷却 {formatClock(cd)}</span>}
      </div>
      <p className="sb-pk-hint">
        题目必须贴合本轮主题「{topic || '（待定）'}」，跑题会被裁判判失败；成功 +1（60s 冷却）
      </p>
      <div className="sb-pk-kind-row" role="radiogroup" aria-label="题型">
        {KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            className={`sb-pk-btn tiny${qKind === k.value ? ' on' : ''}`}
            aria-pressed={qKind === k.value}
            onClick={() => onKind(k.value)}
          >
            {k.label}
          </button>
        ))}
        <PkTermPicker terms={terms} selected={termIds} onChange={onTermIds} />
      </div>
      <form
        className="sb-pk-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <input
          className="sb-pk-input"
          placeholder={
            qKind === 'judge'
              ? '如：出一道判断浮力方向的题（≤300 字）'
              : qKind === 'scenario'
                ? '如：出一道关于浮力的可操作情景 demo（≤300 字）'
                : '如：出一道关于浮力的题（≤300 字）'
          }
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
