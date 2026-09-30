/**
 * DrillParkedPill — 「刷词已收起」小签（2026-09-30；契约 `docs/WAIT-DRILL-SPEC.md` §2.1）。
 *
 * 长在 `ChatComposer` 输入框上方那排状态条里（与「追问模式」条同一位置——**动作可折叠、状态不能藏**）：
 * 一局刷词还在跑但小窗收起了，就露这一签；点签 = 唤回同一局（`requestDrillOpen`），✕ = 结束本局（`requestDrillEnd`）。
 * 没有在跑的局就什么都不渲染——它不是常驻入口（等待气泡与设置卡才是），是"你刚才那局还在"的提醒。
 */
import { requestDrillEnd, useDrillDock } from './drill-dock';
import { requestDrillOpen } from './drill-prefs';
import './drill.css';

export function DrillParkedPill() {
  const dock = useDrillDock();
  if (!dock.parked) return null;
  return (
    <div className="chat-drill-pill" role="status">
      <button type="button" className="chat-drill-recall" onClick={requestDrillOpen} title="唤回刷词小窗，接着刚才那张">
        <span className="chat-drill-tag">WAIT</span>
        刷词已收起 · 还有 {dock.queueLeft} 张
        {dock.combo > 1 && <span className="chat-drill-combo">连击 {dock.combo}</span>}
        <span className="chat-drill-cta">唤回</span>
      </button>
      <button type="button" className="chat-drill-end" onClick={requestDrillEnd} title="结束这一局" aria-label="结束这一局">
        ✕
      </button>
    </div>
  );
}
