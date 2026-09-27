/**
 * PkTermPickerOverlay — 词条选择弹层（`PkTermPicker` 的弹层部分，拆文件保组件 ≤300 行）。
 *
 * 交互：搜索框按词条名/释义前缀过滤 → 点行勾选（上限 `PK_TERM_MAX`，满了禁选并提示）
 * →「完成」收起。**勾选即时生效**（onToggle 直接改 PkMatch 的 state），「完成」只是收起——
 * 关闭弹层不该有「取消」的语义，否则已勾的词条消失会让人以为选了个寂寞。
 */
import { useMemo, useState } from 'react';
import { PK_TERM_MAX } from '@sb/shared';
import type { PkTermOption } from './PkTermPicker';

interface Props {
  terms: PkTermOption[];
  selected: string[];
  onToggle: (id: string) => void;
  onClose: () => void;
}

export function PkTermPickerOverlay({ terms, selected, onToggle, onClose }: Props) {
  const [kw, setKw] = useState('');
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filtered = useMemo(() => {
    const k = kw.trim().toLowerCase();
    if (!k) return terms;
    return terms.filter((t) => t.term.toLowerCase().includes(k) || t.definition.toLowerCase().includes(k));
  }, [terms, kw]);
  const full = selected.length >= PK_TERM_MAX;

  return (
    <div className="sb-pk-term-overlay" role="dialog" aria-label="选择出题词条" onClick={onClose}>
      <div className="sb-pk-term-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sb-pk-term-head">
          <input
            className="sb-pk-input"
            placeholder="搜词条或释义"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            autoFocus
          />
          <span className={`sb-pk-term-count${full ? ' full' : ''}`}>
            {selected.length}/{PK_TERM_MAX}
          </span>
          <button type="button" className="sb-pk-btn tiny" onClick={onClose}>
            完成
          </button>
        </div>
        <p className="sb-pk-hint">
          {full ? `最多选 ${PK_TERM_MAX} 条，先取消一条再换` : '选中的词条是硬约束：出的题必须考察它们，跑题判失败'}
        </p>
        <ul className="sb-pk-term-list">
          {filtered.length === 0 && <li className="sb-pk-term-empty">没有匹配的词条</li>}
          {filtered.map((t) => {
            const on = selectedSet.has(t.id);
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className={`sb-pk-term-row${on ? ' on' : ''}`}
                  aria-pressed={on}
                  onClick={() => onToggle(t.id)}
                >
                  <span className="sb-pk-term-name">{t.term}</span>
                  <span className="sb-pk-term-def">{t.definition}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
