/**
 * BootScreen —— 启动画面（2026-09-27）：`main.tsx` 问 `/api/auth/me` 期间的占位。
 *
 * ★ 它替换的是原先那个 `return null`，但**不改变**原先的取舍（「不闪落地页再跳应用」）：
 *   样式层默认透明、400ms 后才现身（`styles/pixel-motion.css` 的 `.sb-boot`）——本地形态 / 缓存命中
 *   的快路径一帧都不闪；冷启动 / 弱网的慢路径不再是一屏空白，而是营地的团子 ＋ 一条读取条。
 * ★ 减少动态效果下现身动画被全局关掉 ⇒ 保持透明＝退回原先的空白行为；`role="status"` 让读屏用户
 *   仍能听到「正在进入营地」（视觉上有没有现身与此无关）。
 * ★ 零 props、零状态、零计时器：什么时候消失由 `main.tsx` 的鉴权结果决定，这里不持有任何时机。
 */
import { Mascot } from '../features/chat/Mascot';
import { BRAND_NAME } from '../lib/brand';

export function BootScreen() {
  return (
    <div className="sb-boot" role="status" aria-live="polite">
      <Mascot />
      <span className="sb-boot-name">{BRAND_NAME}</span>
      <span className="sb-boot-bar" aria-hidden="true" />
      <span className="sb-boot-text">正在进入营地…</span>
    </div>
  );
}
