/**
 * stream-smooth —— 流式上屏的打字机平滑（v13 体验升级 P0）。
 *
 * 问题：token 事件到达的节奏由服务商决定——池中 AI（stream_mode='once'）的完整答案在
 * 一个 token 帧里整块砸到，按原实现单帧全量上屏就是「啪一下弹出一整屏」，观感断层。
 * 主流做法（豆包/ChatGPT）：不管上游节奏多糙，上屏永远匀速逐字。
 *
 * 做法：token 先进积压缓冲，用**倒计时帧预算**放行——积压出现时预算 48 帧（60fps ≈ 0.8s），
 * 每帧放行 max(下限, 积压/剩余帧数)：剩余帧数递减、放行量递增，**任意积压恰在预算内排空**
 *（不要用「积压/48」——那是对 48 帧常数做的除法，长积压会拖尾约 3s，测试逮住过）。
 * 正常流式积压恒小、按每帧下限跟走，几乎零附加延迟；prefers-reduced-motion 跳过平滑直接落屏。
 */

/** 排空预算帧数：60fps 下 ~0.8s，任意大小的积压都在这之内吐完 */
export const DRAIN_FRAMES = 48;
/** 单帧放行下限（字符）：保证正常流式不受平滑拖慢 */
export const MIN_RATE = 2;

/** 单帧放行量：积压均摊到剩余帧数（剩余越少放行越快），再压每帧下限 */
export function drainRate(backlogLen: number, framesLeft: number): number {
  return Math.max(MIN_RATE, Math.ceil(backlogLen / Math.max(1, framesLeft)));
}

export interface TokenDrain {
  /** token 入积压；每帧放行一批，缓冲见底时触发一次 onDrained */
  push(s: string): void;
  /** 立即全量落屏并清积压（错误收口路径：屏上必须立刻等于库内） */
  flushAll(): void;
  /** 取消帧循环并清积压（不触发 onDrained——切会话由历史重载兜底） */
  cancel(): void;
  /** 是否还有未上屏积压 */
  hasBacklog(): boolean;
}

export function createTokenDrain(
  append: (s: string) => void,
  onDrained: () => void,
  opts: { raf?: (cb: () => void) => number; cancelRaf?: (id: number) => void } = {},
): TokenDrain {
  // 注入优先；无注入且环境无 rAF（测试容器/老浏览器）→ undefined，退化为同步全量落屏
  const raf =
    opts.raf ?? (typeof requestAnimationFrame === 'function' ? (cb: () => void) => requestAnimationFrame(cb) : undefined);
  const cancelRaf =
    opts.cancelRaf ?? (typeof cancelAnimationFrame === 'function' ? (id: number) => cancelAnimationFrame(id) : undefined);
  let buf = '';
  let rafId: number | null = null;
  /** 剩余帧预算：积压从空到非空时重置，逐帧递减到 1（最后一帧全量放行） */
  let framesLeft = DRAIN_FRAMES;
  const reducedMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const step = () => {
    rafId = null;
    if (!buf) {
      onDrained();
      return;
    }
    const rate = reducedMotion ? buf.length : drainRate(buf.length, framesLeft);
    append(buf.slice(0, rate));
    buf = buf.slice(rate);
    framesLeft = Math.max(1, framesLeft - 1);
    rafId = raf?.(step) ?? null;
    if (rafId === null) {
      // raf 缺失（不该发生，防卡死兜底）：剩余全量落屏
      if (buf) append(buf);
      buf = '';
      onDrained();
    }
  };

  const startLoop = () => {
    if (rafId !== null) return;
    framesLeft = DRAIN_FRAMES;
    if (!raf || reducedMotion) {
      flushAll();
      return;
    }
    rafId = raf(step);
  };

  function flushAll(): void {
    if (rafId !== null) {
      cancelRaf?.(rafId);
      rafId = null;
    }
    if (buf) {
      append(buf);
      buf = '';
    }
  }

  return {
    push(s: string) {
      buf += s;
      if (buf && rafId === null) startLoop(); // 空推/循环进行中都不重置预算
    },
    flushAll,
    cancel() {
      if (rafId !== null) {
        cancelRaf?.(rafId);
        rafId = null;
      }
      buf = '';
    },
    hasBacklog: () => buf.length > 0,
  };
}
