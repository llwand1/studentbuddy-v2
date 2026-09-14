/**
 * session-busy —— 侧栏「回复中」徽标判据的回归锁（纯函数）。
 *
 * 这组用例锁的是 2026-09-14 那个真 bug 的三个面：
 * ① **不能漂移**：切到别的会话后，徽标只能出现在真正在跑的那间（并集语义）；
 * ② **不能丢**：当前页那间在流时，即使服务端还没轮到下一拍，也必须已经在集合里；
 * ③ **不能空转**：全停时必须允许停轮询（空闲零请求），并且内容没变时不许换引用（避免无谓重渲染）。
 */
import { describe, it, expect } from 'vitest';
import { busySessionIds, shouldPollActive, sameIds } from './session-busy';

describe('busySessionIds —— 徽标集合（并集，两个来源都带正确的会话 id）', () => {
  it('只看服务端：正在跑的那几间在集合里，别的不在', () => {
    const busy = busySessionIds(null, ['a', 'b']);
    expect(busy.has('a')).toBe(true);
    expect(busy.has('b')).toBe(true);
    expect(busy.has('c')).toBe(false);
  });

  it('只看本地：当前页在流时立刻在集合里（不必等 2s 轮询那一拍）', () => {
    expect(busySessionIds('a', []).has('a')).toBe(true);
  });

  it('★ 并集语义：切走后服务端仍在跑的原会话保留徽标，刚点开的那间不亮', () => {
    // 修复后的真实入参：切到 B 时局部信号已清空（useChatStream 切会话即 setBusy(false)），
    // 只剩服务端那一份真相 ⇒ A 亮、B 不亮。这正是老板要的行为。
    const busy = busySessionIds(null, ['a']);
    expect(busy.has('a')).toBe(true);
    expect(busy.has('b')).toBe(false);
  });

  it('★ 职责边界：本函数只取并集，治不了「调用方没清局部信号」的坏输入', () => {
    // 修复前的上报就是这个形状（局部信号被错标到刚点开的 B）——并集会让 A、B 同时亮。
    // 所以「B 不该亮」不能指望本函数拦，必须由 useChatStream 在切会话时清 busy 挡住。
    // 这条用例把职责边界钉下来：谁负责什么，别指望下游包住上游的错。
    const drifted = busySessionIds('b', ['a']);
    expect(drifted.has('b')).toBe(true);
  });

  it('本地为空 + 服务端为空 ⇒ 谁都没有徽标（不造假阳性）', () => {
    expect(busySessionIds(null, []).size).toBe(0);
  });

  it('空串不作为会话 id 混进集合（防撞上一个标题为空的列表项）', () => {
    expect(busySessionIds('', []).size).toBe(0);
  });

  it('本地与服务端指向同一间时不重复（Set 天然去重，取并集不取加法）', () => {
    expect(busySessionIds('a', ['a']).size).toBe(1);
  });
});

describe('shouldPollActive —— 轮询闸门（空闲零请求）', () => {
  it('有在跑的才盯服务端', () => {
    expect(shouldPollActive(busySessionIds(null, ['a']))).toBe(true);
  });

  it('全停了就不盯（否则后台常驻一个 2s 心跳）', () => {
    expect(shouldPollActive(busySessionIds(null, []))).toBe(false);
  });
});

describe('sameIds —— 轮询结果比对（内容没变就别换引用）', () => {
  it('逐项相同（含顺序）判等 ⇒ 可保持原引用、省掉一次无谓重渲染', () => {
    expect(sameIds([], [])).toBe(true);
    expect(sameIds(['a', 'b'], ['a', 'b'])).toBe(true);
  });

  it('长度或顺序变了都判不等 ⇒ 必须换引用，否则徽标会停在旧状态', () => {
    expect(sameIds(['a'], [])).toBe(false);
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(false);
  });
});
