import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { SidebarIcon } from './icons';
import { BRAND_NAME } from '../lib/brand';
import { useLandingLang } from '../app/landing-lang';
import { SHELL } from '../app/shell-copy';

/** Mobile drawer keeps every existing navigation, history and account control reachable. */
export interface SidebarDrawer {
  open: boolean;
  onChange: (open: boolean) => void;
  toggle: RefObject<HTMLButtonElement>;
}
export function SidebarMenuButton({ drawer }: { drawer: SidebarDrawer }) {
  const { lang } = useLandingLang();
  const label = drawer.open ? SHELL.drawerClose[lang] : SHELL.drawerOpen[lang];
  return <button ref={drawer.toggle} type="button" className="reading-tool sb-toolbar-menu"
    aria-label={label} title={label} aria-expanded={drawer.open} aria-controls="sb-sidebar-content"
    onKeyDown={e => { if (e.key === 'Escape' && drawer.open) { e.stopPropagation(); drawer.onChange(false); } }}
    onClick={() => drawer.onChange(!drawer.open)}><SidebarIcon aria-hidden="true" /></button>;
}
export function PixelSidebar({ children, collapsed = false, drawer }: { children: ReactNode; collapsed?: boolean; drawer?: SidebarDrawer }) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = drawer?.open ?? localOpen;
  const setOpen = drawer?.onChange ?? setLocalOpen;
  /** 抽屉按钮与遮罩的无障碍名跟着全局语言走（词表见 app/shell-copy.ts） */
  const { lang } = useLandingLang();
  const localToggle = useRef<HTMLButtonElement>(null);
  const toggle = drawer?.toggle ?? localToggle;
  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  return (
    <aside className={`sb-sidebar${drawer ? ' is-toolbar-drawer' : ''}${open ? ' is-open' : ''}${collapsed ? ' is-collapsed' : ''}`} onKeyDown={(e) => {
      if (e.key === 'Escape' && open) { e.stopPropagation(); close(); }
    }}>
      {!drawer && <div className="sb-mobile-bar">
        <span>{BRAND_NAME}</span>
        <button ref={toggle} type="button" className="sb-mobile-toggle" aria-expanded={open}
          aria-controls="sb-sidebar-content" onClick={() => setOpen(!open)}>
          {open ? SHELL.drawerClose[lang] : SHELL.drawerOpen[lang]}
        </button>
      </div>}
      {open && <button type="button" className="sb-mobile-backdrop" tabIndex={-1} aria-label={SHELL.navClose[lang]} onClick={close} />}
      <div className="sb-sidebar-content" id="sb-sidebar-content" onClick={(e) => {
        if (open && e.target instanceof Element && e.target.closest('.sb-nav-item, .sb-logo, .sb-new-chat, .sb-session-title')) close();
      }}>
        {children}
      </div>
    </aside>
  );
}
