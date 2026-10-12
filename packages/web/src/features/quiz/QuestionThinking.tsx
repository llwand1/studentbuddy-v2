import { useId, useState } from 'react';
import { QUIZ_THOUGHT_MAX } from '@sb/shared';
import './question-thinking.css';
export function QuestionThinking({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(() => !!value);
  const id = useId();
  return <div className="quiz-thinking">
    <button type="button" className="quiz-thinking-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)}>
      ✎ 我的思考 / 评价 <small>选填</small>{value && !open && <span> · 已有记录</span>}
    </button>
    {open && <div id={id} className="quiz-thinking-body"><label htmlFor={`${id}-input`}>记录解题步骤、疑问，或对题目的评价</label>
      <textarea id={`${id}-input`} aria-label="我的思考 / 评价" value={value} rows={3} maxLength={QUIZ_THOUGHT_MAX} disabled={disabled}
        placeholder="例如：我先排除了 B，但不确定 A 和 C 的区别……也可以评价题目是否有歧义。" onChange={e => onChange(e.target.value)} />
      <small>{value.length} / {QUIZ_THOUGHT_MAX} · {disabled ? '本轮提交时的思考' : '按需填写，交卷前可修改'}</small>
    </div>}
  </div>;
}
