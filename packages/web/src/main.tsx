/**
 * 应用入口。顶层 hash 路由（零依赖，不引 react-router——@sb/web 保持零运行时依赖）：
 * `#/pk` 进 AI 出题 PK 独立页（移动优先，契约 docs/PK-SPEC.md §5），其余进学习助手主壳。
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { PkApp } from './features/pk/PkApp';
import './styles/tokens.css';

function isPkHash(): boolean {
  const h = window.location.hash;
  return h === '#/pk' || h.startsWith('#/pk/');
}

function Root() {
  const [pk, setPk] = useState(() => isPkHash());
  useEffect(() => {
    const on = () => setPk(isPkHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return pk ? <PkApp /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
