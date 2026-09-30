/**
 * TypingInput — 「打字练习式」填空控件（2026-09-30；口径在 `@sb/shared/typing`，契约 `docs/WAIT-DRILL-SPEC.md` §5.2）。
 *
 * 用户的原话：填空要像打字练习软件——**一格一字**、可以**分段给提示**、**不用打符号**。三处填空共用：
 * 刷词拼写卡 / 知识大陆填空题 / 对话出题的填空。
 *   - 一个真输入框（视觉隐藏、仍可聚焦，输入法照常组字）接键盘；格子只是它的可视化。点格子 = 聚焦输入框。
 *   - 空格与符号是固定格（灰、替你填好、不占键入位）；键入的符号直接丢（`clampTyped`），只能打字母数字汉字。
 *   - 「提示」一次揭一段（`seg`）：未打的格里显出灰字，仍要自己打进去（打字练习的规矩，不是替你填）。
 *   - `liveCheck`：逐格即时对错（练习场景开；正经考题关，只看格子不看对错）。
 *   - 输入法组字期间不回写（`isComposing`）：否则拼音字母会先落进格子再被汉字替换，闪一下还可能截断组字。
 * ★ 受控：`value` 是**带符号的完整答案**（`mergeTyped`），父组件拿它直接喂既有判分；格子内部再抠回打过的字。
 * ★ 纯展示 + 回调，不 import 任何 API；样式只用 `--sb-*` 变量，各宿主用父级 class 微调（见 typing-input.css）。
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { cellVerdicts, clampTyped, mergeTyped, segmentCount, typedCount, typedOf, typingCells } from '@sb/shared';
import './typing-input.css';

export interface TypingInputProps {
  /** 目标答案（决定格子布局；不会显示出来，除非按了提示） */
  answer: string;
  /** 当前作答（带符号的完整答案，`mergeTyped` 的产物；空串 = 还没打） */
  value: string;
  onChange: (full: string) => void;
  /** 回车（不在组字中）⇒ 提交；不传则回车什么都不做 */
  onSubmit?: () => void;
  disabled?: boolean;
  /** 逐格即时对错（练习场景） */
  liveCheck?: boolean;
  /** 允许分段提示（默认允许） */
  hintable?: boolean;
  autoFocus?: boolean;
  ariaLabel?: string;
  /** 用了几次提示（宿主想记账时用） */
  onHint?: (used: number, total: number) => void;
}

export function TypingInput({
  answer,
  value,
  onChange,
  onSubmit,
  disabled = false,
  liveCheck = false,
  hintable = true,
  autoFocus = false,
  ariaLabel = '逐字作答',
  onHint,
}: TypingInputProps) {
  const cells = useMemo(() => typingCells(answer), [answer]);
  const total = typedCount(cells);
  const segs = segmentCount(cells);
  const typed = typedOf(cells, value);
  const verdicts = liveCheck ? cellVerdicts(cells, typed) : null;
  const [hints, setHints] = useState(0);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const countId = useId();

  // 换题（answer 变）⇒ 提示归零
  useEffect(() => setHints(0), [answer]);
  useEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true });
  }, [autoFocus, answer]);
  // 非受控输入框 + 手动同步：组字中不能被 React 回写（会把半个拼音截掉），所以不用 value= 受控
  useEffect(() => {
    const el = input.current;
    if (el && !composing.current && el.value !== typed) el.value = typed;
  }, [typed]);

  const commit = (raw: string) => onChange(mergeTyped(cells, clampTyped(cells, raw)));
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && !composing.current) {
      e.preventDefault();
      onSubmit?.();
    }
  };
  const hint = () => {
    if (hints >= segs) return;
    const next = hints + 1;
    setHints(next);
    onHint?.(next, segs);
    input.current?.focus({ preventScroll: true });
  };

  // 光标格 = 第一个还没打的可打格
  let cur = -1;
  let seen = 0;
  cells.forEach((c, i) => {
    if (!c.typed) return;
    if (cur < 0 && seen >= [...typed].length) cur = i;
    seen += 1;
  });
  const typedChars = [...typed];
  let p = 0;
  const words: ReactElement[][] = [[]];
  cells.forEach((c, i) => {
    if (!c.typed && c.ch === ' ') {
      words.push([]);
      return;
    }
    let text = '';
    let cls = 'ti-cell';
    if (!c.typed) {
      cls += ' fixed';
      text = c.ch;
    } else {
      const got = typedChars[p];
      p += 1;
      if (got !== undefined) {
        text = got;
        cls += ' filled';
        const v = verdicts?.[i];
        if (v) cls += ` ${v}`;
      } else if (c.seg < hints) {
        text = c.ch;
        cls += ' ghost';
      }
      if (i === cur && focused && !disabled) cls += ' cur';
    }
    words[words.length - 1]?.push(<span key={i} className={cls}>{text}</span>);
  });

  return (
    <div className={`ti${disabled ? ' is-disabled' : ''}${focused ? ' is-focused' : ''}`}>
      <div
        className="ti-cells"
        aria-hidden="true"
        onMouseDown={(e) => {
          e.preventDefault();
          input.current?.focus({ preventScroll: true });
        }}
        onClick={() => input.current?.focus({ preventScroll: true })}
      >
        {words.map((w, wi) => (
          <span key={wi} className="ti-word">{w}</span>
        ))}
      </div>
      <input
        ref={input}
        className="ti-input"
        type="text"
        defaultValue={typed}
        disabled={disabled}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-label={ariaLabel}
        aria-describedby={countId}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(e) => { composing.current = false; commit(e.currentTarget.value); }}
        onChange={(e) => { if (!composing.current) commit(e.currentTarget.value); }}
        onKeyDown={onKeyDown}
      />
      <div className="ti-foot">
        <span className="ti-count" id={countId}>
          {typedChars.length}/{total} 字{cells.length > total ? '（空格与符号已替你填好）' : ''}
        </span>
        {hintable && segs > 0 && !disabled && (
          <button type="button" className="ti-hint" disabled={hints >= segs} onClick={hint}>
            {hints >= segs ? '提示已用完' : `提示 ${hints}/${segs}`}
          </button>
        )}
      </div>
    </div>
  );
}
