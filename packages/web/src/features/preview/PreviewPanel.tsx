/**
 * PreviewPanel — 应用右侧「内置浏览器」：只挂模型产出的沙箱预览页（/api/preview/:id）。
 *
 * 隔离靠两层同向的策略：服务端出页已带 `CSP: sandbox`（不含 allow-same-origin），iframe 再叠
 * `sandbox="allow-scripts allow-modals allow-forms"`——都不给 same-origin ⇒ 文档源为 null，
 * demo 照跑，但读不到本应用 localStorage、调不动写接口。
 * 刻意没有地址栏：本面板不承诺打开任意 URL（外站大多拒绝被嵌，且会引入点击劫持面）。
 */
import { useSyncExternalStore } from 'react';
import { closePreview, getPreview, refreshPreview, subscribePreview } from '../../lib/preview-store';
import './panel.css';

export function PreviewPanel() {
  const target = useSyncExternalStore(subscribePreview, getPreview, getPreview);
  if (!target) return null;

  return (
    <aside className="sb-browser">
      <header className="sb-browser-head">
        <span className="sb-browser-badge">沙箱</span>
        <span className="sb-browser-title" title={target.url}>
          {target.label}
        </span>
        <span className="sb-browser-actions">
          <button className="sb-browser-btn" onClick={refreshPreview} title="重新载入预览页">
            刷新
          </button>
          <button
            className="sb-browser-btn"
            onClick={() => window.open(target.url, '_blank', 'noopener')}
            title="改在新标签页打开"
          >
            新标签页
          </button>
          <button className="sb-browser-btn sb-browser-close" onClick={closePreview} title="关闭面板">
            ×
          </button>
        </span>
      </header>
      <div className="sb-browser-note">
        <span>预览页在独立沙箱里运行，读不到本应用的会话与设置数据</span>
      </div>
      {/* key 带 nonce：同一份预览点「刷新」也强制重挂 iframe */}
      <iframe
        key={`${target.url}#${target.nonce}`}
        className="sb-browser-frame"
        src={target.url}
        title={target.label}
        sandbox="allow-scripts allow-modals allow-forms"
      />
    </aside>
  );
}
