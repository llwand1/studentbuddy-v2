/**
 * stream-smooth —— 打字机平滑排空器回归。
 * 核心不变量：①不丢字（排空后拼接===原文，屏上==库内铁律的前端半边）；
 * ②任意积压 ~0.8s（48 帧）内排空；③正常流式小 token 不受拖慢；④onDrained 恰好一次。
 * rAF 用注入的假调度器手动推帧，不依赖真实帧循环。
 */
import { describe, expect, it } from 'vitest';
import { createTokenDrain, DRAIN_FRAMES, drainRate } from './stream-smooth.js';

function makeHarness() {
  const queue: Array<() => void> = [];
  const appended: string[] = [];
  let drained = 0;
  const drain = createTokenDrain(
    (s) => appended.push(s),
    () => {
      drained += 1;
    },
    {
      raf: (cb) => {
        queue.push(cb);
        return queue.length; // 1-based id
      },
      cancelRaf: (id) => {
        queue[id - 1] = () => undefined;
      },
    },
  );
  return {
    drain,
    appended,
    get drained() {
      return drained;
    },
    get pendingFrames() {
      return queue.length;
    },
    /** 推进一帧（被 cancel 的帧是空函数，推了等于没推） */
    flushFrame: () => queue.shift()?.(),
  };
}

describe('drainRate（单帧放行量，倒计时帧预算口径）', () => {
  it('小积压按下限 2 放行（正常流式不受平滑拖慢）', () => {
    expect(drainRate(0, 48)).toBe(2);
    expect(drainRate(1, 48)).toBe(2);
    expect(drainRate(96, 48)).toBe(2);
  });

  it('放行量 = 积压/剩余帧数：剩余越少放行越快（★ 不能是 积压/常数——那会拖尾 ~3s，测试逮住过）', () => {
    expect(drainRate(4800, 48)).toBe(100);
    expect(drainRate(4800, 24)).toBe(200);
    expect(drainRate(4800, 1)).toBe(4800); // 最后一帧全量放行兜底
  });
});

describe('createTokenDrain', () => {
  it('整块到达（池中 once）：匀速排空、不丢字、onDrained 恰好一次', () => {
    const h = makeHarness();
    const text = 'x'.repeat(2000);
    h.drain.push(text);
    expect(h.appended).toHaveLength(0); // 首帧前不上屏

    let frames = 0;
    while (h.pendingFrames > 0 && frames < 200) {
      h.flushFrame();
      frames += 1;
    }
    expect(h.appended.join('')).toBe(text); // 逐段拼接 === 原文
    expect(frames).toBeLessThanOrEqual(DRAIN_FRAMES + 1); // 排空帧 + 收口帧
    expect(h.drained).toBe(1);
  });

  it('正常流式：小 token 当帧就落屏，几乎零附加延迟', () => {
    const h = makeHarness();
    h.drain.push('你');
    h.flushFrame();
    expect(h.appended).toEqual(['你']);
    h.flushFrame(); // 缓冲见底帧
    expect(h.drained).toBe(1);
  });

  it('流式与积压混流：继续 push 续上循环，字序不乱', () => {
    const h = makeHarness();
    h.drain.push('12345');
    h.drain.push('678');
    h.flushFrame(); // 一帧放行 max(2, ceil(8/48))=2 → '12'
    h.flushFrame(); // '34'
    expect(h.appended.join('')).toBe('1234');
    h.drain.flushAll();
    expect(h.appended.join('')).toBe('12345678');
  });

  it('flushAll：立即全量落屏（错误收口路径），清空积压', () => {
    const h = makeHarness();
    h.drain.push('y'.repeat(500));
    h.drain.flushAll();
    expect(h.appended.join('')).toBe('y'.repeat(500));
    expect(h.drain.hasBacklog()).toBe(false);
  });

  it('cancel：积压丢弃、不落屏、不触发 onDrained，残留帧不再干活', () => {
    const h = makeHarness();
    h.drain.push('z'.repeat(500));
    h.drain.cancel();
    expect(h.drain.hasBacklog()).toBe(false);
    expect(h.appended).toHaveLength(0);
    const before = h.drained;
    h.flushFrame();
    expect(h.drained).toBe(before);
  });

  it('空 push 不误触 onDrained（空积压不启动循环）', () => {
    const h = makeHarness();
    h.drain.push('');
    h.flushFrame();
    h.flushFrame();
    expect(h.drained).toBe(0);
    expect(h.pendingFrames).toBe(0);
  });
});
