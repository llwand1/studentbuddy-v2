/**
 * ComposerMenu — 输入框的「+」展开菜单（对话页动作入口都收进这里）。
 *
 * 存在理由：改版前对话页 composer 一行里并排着「出题」「联网开关」「存入记忆」「导出」四个按钮，
 * 输入框被挤成一条缝。主流做法（WorkBuddy / ChatGPT 同款）是收进一个「+」，
 * 点开才展开动作清单——**动作可以折叠，状态不能藏**，故 `status` 会挂在触发器上一直可见。
 *
 * 只有对话页用它（原先的第二处候选是题库页那一行，2026-09-26 随题库整族下线）。以后哪页需要，直接用即可。
 *
 * ★ **可扩展是硬要求**（老板明确提的「之后的功能也要预留」）：本组件不认识任何具体功能，
 * 只消费 `items` 数组。以后加功能＝往数组里加一项，本文件与 CSS 都不用动。
 * 两种条目形态够用且语义分明：
 * - `action`：一次性动作（出题 / 存入记忆 / 导出…），点完**收起菜单**；
 * - `toggle`：开关（联网搜索…），点完**保持展开**——用户可以连着翻两次看状态变化，
 *   且条目右侧的「已开/已关」就是即时反馈（收起菜单会把反馈一起收掉）。
 *
 * 无障碍：触发器带 `aria-expanded`/`aria-haspopup`，条目按形态给 `menuitem`/`menuitemcheckbox`；
 * 支持 ESC 关闭与点外部关闭（缺后两者时，菜单会粘在屏幕上只能靠再次点「+」关）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PlusIcon, CheckIcon } from './icons';
import './composer-menu.css';

export type ComposerMenuItem =
  | {
      kind: 'action';
      key: string;
      label: string;
      icon: ReactNode;
      title?: string;
      disabled?: boolean;
      onClick: () => void;
    }
  | {
      kind: 'toggle';
      key: string;
      label: string;
      title?: string;
      disabled?: boolean;
      on: boolean;
      onChange: (on: boolean) => void;
    };

export function ComposerMenu({
  items,
  status,
  disabled,
  title = '更多功能',
}: {
  items: ComposerMenuItem[];
  /** 触发器上的状态摘要（如「联网已开」）；`null` 时不显示——不留一句空话 */
  status?: string | null;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 点外部 / ESC 关闭：菜单是覆盖层，没有这两条就只能靠再点一次「+」
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="composer-menu" ref={boxRef}>
      <button
        type="button"
        className={open ? 'composer-menu-btn open' : 'composer-menu-btn'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={status ? `${title}（${status}）` : title}
        title={status ? `${title}（${status}）` : title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <PlusIcon />
        {status && <span className="composer-menu-status">{status}</span>}
      </button>

      {open && (
        <div className="composer-menu-panel" role="menu">
          {items.map((it) =>
            it.kind === 'action' ? (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                className="composer-menu-item"
                title={it.title}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                <span className="composer-menu-ico">{it.icon}</span>
                <span className="composer-menu-label">{it.label}</span>
              </button>
            ) : (
              <button
                key={it.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={it.on}
                className={it.on ? 'composer-menu-item on' : 'composer-menu-item'}
                title={it.title}
                disabled={it.disabled}
                onClick={() => it.onChange(!it.on)}
              >
                <span className="composer-menu-ico">{it.on && <CheckIcon size={15} />}</span>
                <span className="composer-menu-label">{it.label}</span>
                <span className="composer-menu-state">{it.on ? '已开' : '已关'}</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
