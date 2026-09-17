/**
 * ZoomBar —— 编排画布右下角的缩放控制条。
 *
 * ★ 为什么必须**显式存在**（2026-09-17 老板实测：「构建的主图应该自带放大缩小的功能,不然看不清」）：
 *   滚轮缩放在没有任何可见控件时等于不存在——用户不会去猜。本仓不接受
 *   「功能做了但用户以为没有」，所以控件和「滚轮缩放 · 拖动平移」这行提示都要露在面上。
 * ★ 百分比按钮兼作「回到 100%」：缩到 35% 之后，最想要的动作就是一键还原，
 *   不必再让用户去点若干次「+」（也不靠双击空白这类全靠猜的手势）。
 * ★ 图标是自绘 SVG 线条（本仓规矩：禁 emoji 当图标）。
 */
import { FitIcon, MinusIcon, PlusIcon } from '../../components/icons';

const ICON = 16;

export function ZoomBar({
  percent,
  onZoomIn,
  onZoomOut,
  onReset,
  onFit,
}: {
  percent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onFit: () => void;
}) {
  return (
    <div className="fl-zoom" role="group" aria-label="画布缩放">
      <span className="fl-zoom-hint">滚轮缩放 · 拖动平移</span>
      <button type="button" className="fl-zoom-btn" onClick={onZoomOut} title="缩小" aria-label="缩小">
        <MinusIcon size={ICON} />
      </button>
      <button type="button" className="fl-zoom-pct" onClick={onReset} title="回到 100%">
        {percent}%
      </button>
      <button type="button" className="fl-zoom-btn" onClick={onZoomIn} title="放大" aria-label="放大">
        <PlusIcon size={ICON} />
      </button>
      <span className="fl-zoom-sep" />
      <button type="button" className="fl-zoom-btn" onClick={onFit} title="适配窗口（看全貌）" aria-label="适配窗口">
        <FitIcon size={ICON} />
      </button>
    </div>
  );
}
