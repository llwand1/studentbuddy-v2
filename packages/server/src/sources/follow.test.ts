/**
 * follow：页内跳转的许可登记（契约 `docs/SOURCE-TRACE-SPEC.md` §14.2）。
 *
 * 这是**安全相关**的一块：它决定 `/read`、`/view` 会不会从「只服务架上网址」退化成开放代理。
 * 所以钉的全是边界，而不是 happy path：
 *   ① 没确认过的网址**一律不认**（默认拒绝）；
 *   ② 许可按**会话隔离**——A 会话确认过的不能让 B 会话白嫖；
 *   ③ 有**上限**，撞了返回 false 让路由回 429（静默丢弃＝用户点了确认却跳不动还没解释）；
 *   ④ 有 **TTL**，过期自动失效（宁可让人再确认一次，不可悄悄多放行一个）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FOLLOW_MAX_PER_SESSION, approveFollow, followCount, isFollowApproved, resetFollow } from './follow.js';

const A = 'sess-a';
const B = 'sess-b';
const U = 'https://example.com/page';

beforeEach(() => resetFollow());

describe('follow：默认拒绝', () => {
  it('① 没确认过 ⇒ 不认（这是 /read 不退化成开放代理的根据）', () => {
    expect(isFollowApproved(A, U)).toBe(false);
  });

  it('确认过才认；同一网址重复确认不重复计数', () => {
    expect(approveFollow(A, U)).toBe(true);
    expect(isFollowApproved(A, U)).toBe(true);
    approveFollow(A, U);
    expect(followCount(A)).toBe(1);
  });
});

describe('follow：会话隔离与上限', () => {
  it('② A 确认过的，B 不认', () => {
    approveFollow(A, U);
    expect(isFollowApproved(B, U)).toBe(false);
  });

  it('③ 撞上限返回 false（路由据此回 429 并说清怎么办）', () => {
    for (let i = 0; i < FOLLOW_MAX_PER_SESSION; i += 1) {
      expect(approveFollow(A, `https://example.com/${i}`)).toBe(true);
    }
    expect(followCount(A)).toBe(FOLLOW_MAX_PER_SESSION);
    expect(approveFollow(A, 'https://example.com/one-more')).toBe(false);
    // 撞上限之后，已确认过的仍然有效——不能因为满了就把人正在读的那页也踢掉
    expect(isFollowApproved(A, 'https://example.com/0')).toBe(true);
  });

  it('③ 上限只卡新网址：满了之后重复确认旧网址仍放行', () => {
    for (let i = 0; i < FOLLOW_MAX_PER_SESSION; i += 1) approveFollow(A, `https://example.com/${i}`);
    expect(approveFollow(A, 'https://example.com/5')).toBe(true);
  });
});

describe('follow：TTL', () => {
  it('④ 超过 2 小时没动静 ⇒ 许可整会话失效', () => {
    const t0 = 1_000_000;
    approveFollow(A, U, t0);
    expect(isFollowApproved(A, U, t0 + 60_000)).toBe(true);
    expect(isFollowApproved(A, U, t0 + 2 * 60 * 60_000 + 1)).toBe(false);
  });

  it('④ 期间有新确认会续期（人还在读就不该把他踢回去重新点）', () => {
    const t0 = 1_000_000;
    approveFollow(A, U, t0);
    approveFollow(A, 'https://example.com/second', t0 + 60 * 60_000);
    expect(isFollowApproved(A, U, t0 + 90 * 60_000)).toBe(true);
  });
});

describe('follow：重置', () => {
  it('按会话重置与全量重置都生效', () => {
    approveFollow(A, U);
    approveFollow(B, U);
    resetFollow(A);
    expect(isFollowApproved(A, U)).toBe(false);
    expect(isFollowApproved(B, U)).toBe(true);
    resetFollow();
    expect(isFollowApproved(B, U)).toBe(false);
  });
});
