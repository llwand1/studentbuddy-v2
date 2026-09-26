import { useRef, useState, type ReactNode } from 'react';
import { BRAND_NAME } from '../lib/brand';

/** Mobile drawer keeps every existing navigation, history and account control reachable. */
export function PixelSidebar({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  return (
    <aside className={`sb-sidebar${open ? ' is-open' : ''}`} onKeyDown={(e) => {
      if (e.key === 'Escape' && open) { e.stopPropagation(); close(); }
    }}>
      <div className="sb-mobile-bar">
        <span>{BRAND_NAME}</span>
        <button ref={toggle} type="button" className="sb-mobile-toggle" aria-expanded={open}
          aria-controls="sb-sidebar-content" onClick={() => setOpen(!open)}>
          {open ? '收起菜单' : '探索菜单'}
        </button>
      </div>
      {open && <button type="button" className="sb-mobile-backdrop" tabIndex={-1} aria-label="关闭导航" onClick={close} />}
      <div className="sb-sidebar-content" id="sb-sidebar-content" onClick={(e) => {
        if (open && e.target instanceof Element && e.target.closest('.sb-nav-item, .sb-logo, .sb-new-chat, .sb-session-title')) close();
      }}>
        {children}
      </div>
    </aside>
  );
}
