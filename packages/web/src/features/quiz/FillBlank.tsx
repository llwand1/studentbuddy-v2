/**
 * FillBlank — 对话出题 / 大陆题卡回放里**一个填空**的输入（2026-09-30）。
 *
 * 参考答案适合逐格打（`spellFriendly`：≤24 格、可打字符 ≥70%）⇒ 打字练习式 `TypingInput`（一格一字、符号格替你填好、
 * 「提示」按段揭）；整句 / 满是符号的答案 ⇒ 普通输入框。格子会暴露答案长度，这是打字练习的代价，用户选的口径；
 * 想写同义说法的人可以点「自由输入」换回普通框（AI 评分那条路 `AiGradeNote` 本来就接住字面不匹配的情况）。
 * ★ 正经考题不开逐格对错（那会把答案一格格试出来）；`value` 始终是带符号的完整字符串，`reviewAttempt` 判分口径不变。
 */
import { useState } from 'react';
import { spellFriendly } from '@sb/shared';
import { TypingInput } from '../../components/TypingInput';

interface Props {
  /** 这一空的参考答案（没有就只能普通输入） */
  expected: string | undefined;
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  disabled: boolean;
  label: string;
  placeholder: string;
}

export function FillBlank({ expected, value, onChange, onEnter, disabled, label, placeholder }: Props) {
  const [free, setFree] = useState(false);
  const cells = !free && !!expected && spellFriendly(expected);
  return (
    <div className={cells ? 'quiz-blank is-cells' : 'quiz-blank'}>
      <span className="quiz-blank-label">
        {label}
        {cells && !disabled && (
          <button type="button" className="quiz-blank-free" onClick={() => { setFree(true); onChange(''); }}>
            自由输入
          </button>
        )}
      </span>
      {cells ? (
        <TypingInput answer={expected} value={value} onChange={onChange} onSubmit={onEnter} disabled={disabled} ariaLabel={label} />
      ) : (
        <input
          className="quiz-fill"
          value={value}
          maxLength={500}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) onEnter?.();
          }}
        />
      )}
    </div>
  );
}
