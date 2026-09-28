import { useRef, useState, type ReactNode } from 'react';
import { BRAND_NAME } from '../lib/brand';
import { useLandingLang } from '../app/landing-lang';
import { SHELL } from '../app/shell-copy';

/** Mobile drawer keeps every existing navigation, history and account control reachable. */
export function PixelSidebar({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  /** 抽屉按钮与遮罩的无障碍名跟着全局语言走（词表见 app/shell-copy.ts） */
  const { lang } = useLandingLang();
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
          {open ? SHELL.drawerClose[lang] : SHELL.drawerOpen[lang]}
        </button>
      </div>
      {open && <button type="button" className="sb-mobile-backdrop" tabIndex={-1} aria-label={SHELL.navClose[lang]} onClick={close} />}
      <div className="sb-sidebar-content" id="sb-sidebar-content" onClick={(e) => {
        if (open && e.target instanceof Element && e.target.closest('.sb-nav-item, .sb-logo, .sb-new-chat, .sb-session-title')) close();
      }}>
        {children}
      </div>
    </aside>
  );
}
