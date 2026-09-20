/**
 * PkTermPicker — 对战出题的词条选择器（PK-SPEC §15 B3，2026-09-20）。
 *
 * 老板拍板「**可选 + 选了即硬绑定**」：不选＝照原路径出题（请求体不带 termIds 字段）；
 * 选了＝词条是硬约束（跑题由裁判判失败），上限 5 条（shared `PK_TERM_MAX`）。
 *
 * UI：chips（已选，点 × 移除）+「词条」按钮开弹层（搜索过滤 + 点行勾选 + 计数）。
 * 词条数据由 `PkMatch` 挂载时拉一次（`api.terms.list()`），本组件只做选择交互——
 * 数据获取不进展示组件，与 PkQuizBlock 同一分工。
 */
import { useMemo, useState } from 'react';
import { PK_TERM_MAX } from '@sb/shared';
import { PkTermPickerOverlay } from './PkTermPickerOverlay';

/** 词条选择的最小视图形状（结构类型）：api 与 shared 两套 TermItem 形状不同，展示层只认这三个字段 */
export interface PkTermOption {
  id: string;
  term: string;
  definition: string;
}

interface Props {
  /** 我的词条库（PkMatch 挂载时拉的快照；拉取失败＝空列表，选择器退化为「词条库为空」提示） */
  terms: PkTermOption[];
  /** 已选词条 id（状态在 PkMatch，提交时随请求带走） */
  selected: string[];
  onChange: (ids: string[]) => void;
}

export function PkTermPicker({ terms, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const byId = useMemo(() => new Map(terms.map((t) => [t.id, t])), [terms]);
  /** 保证 chips 显示名稳定：候选失效（被删）的 id 仍显示短 id，不静默吞 */
  const chosen = selected.map((id) => byId.get(id) ?? { id, term: `词条 ${id.slice(0, 6)}…`, definition: '' });

  const toggle = (id: string): void => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else if (selected.length < PK_TERM_MAX) onChange([...selected, id]);
  };

  return (
    <div className="sb-pk-term-picker">
      {chosen.length > 0 && (
        <div className="sb-pk-term-chips">
          {chosen.map((t) => (
            <button
              key={t.id}
              type="button"
              className="sb-pk-term-chip"
              title="点击移除"
              onClick={() => toggle(t.id)}
            >
              {t.term}
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="sb-pk-btn tiny"
        disabled={terms.length === 0 && selected.length === 0}
        onClick={() => setOpen(true)}
      >
        {selected.length > 0 ? `词条 ${selected.length}/${PK_TERM_MAX}` : '词条出题'}
      </button>
      {open && (
        <PkTermPickerOverlay
          terms={terms}
          selected={selected}
          onToggle={toggle}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
