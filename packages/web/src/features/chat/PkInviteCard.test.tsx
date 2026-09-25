// @vitest-environment jsdom
/**
 * PkInviteCard.test — 对战邀请卡的渲染锁（契约 docs/PK-SPEC.md §16.9）。
 *
 * 本卡与 `ConfirmCard` 同族，但锁的东西不一样：确认门卡锁「信息够不够拍板」，
 * 这张卡锁**一句话有没有说谎**——
 * ① 必须写清「你出一题、AI 也出一题」。只说「来一局对战」，学习者会以为是自己去做一套题，
 *    这是货不对板（契约把这句列为硬要求的原由）。
 * ② 必须当面说「不接受也没关系」：邀请的压力感全来自「不点会不会得罪 AI」。
 * ③ 接受后的「进入对局」只能指向**这一局**的房间 ⇒ href 由 `pkRoomHash` 一处算，
 *    而 `roomId` 为 null 的卡（刷新后内存房没了）不许渲染出链接——
 *    点了跳到 `#/pk?roomId=undefined` 会让人以为产品坏了。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import type { PkInviteRecord } from '@sb/shared';
import { PkInviteCard } from './PkInviteCard';
import { pkRoomHash, type PkInviteQueue } from './usePkInviteQueue';

const base: PkInviteRecord = {
  id: 'i1',
  sessionId: 's1',
  ownerId: 'o1',
  topic: '牛顿第二定律',
  reason: '这块你已经推了两轮，值得打一局验一下',
  status: 'pending',
  roomId: null,
  createdAt: 1_000,
};

function setup(
  over: Partial<PkInviteRecord> = {},
  extra: Partial<PkInviteQueue> = {},
): { acceptInvite: ReturnType<typeof vi.fn>; rejectInvite: ReturnType<typeof vi.fn>; dismissInvite: ReturnType<typeof vi.fn> } {
  const acceptInvite = vi.fn().mockResolvedValue(true);
  const rejectInvite = vi.fn();
  const dismissInvite = vi.fn();
  const invite: PkInviteRecord = { ...base, ...over };
  render(
    <PkInviteCard
      queue={{
        invite,
        inviteBusy: false,
        applyEvent: () => false,
        acceptInvite,
        rejectInvite,
        dismissInvite,
        ...extra,
      }}
    />,
  );
  return { acceptInvite, rejectInvite, dismissInvite };
}

const text = () => document.body.textContent ?? '';
const href = () => document.querySelector('a.choice-dismiss')?.getAttribute('href');

afterEach(() => cleanup());

describe('挂起态：硬要求文案 + 两个按钮', () => {
  it('说清「你出一题让 AI 答、AI 出一题让你答」，也当面给出逃生口', () => {
    setup();
    expect(text()).toContain('你出一题让 AI 答');
    expect(text()).toContain('AI 出一题让你答');
    expect(text()).toContain('不想打就点');
    expect(text()).toContain('不会等你');
  });

  it('主题与那句「为什么现在值得打一局」都上屏（卡片认的是这两样，不是题目）', () => {
    setup();
    expect(text()).toContain('牛顿第二定律');
    expect(text()).toContain('值得打一局验一下');
  });

  it('两个按钮各归各动作：接受 = 异步动作（由 hook 负责跳转），拒绝 = 同步回执', () => {
    const { acceptInvite, rejectInvite } = setup();
    fireEvent.click(document.querySelector('.confirm-btn.ok')!);
    expect(acceptInvite).toHaveBeenCalledTimes(1);
    fireEvent.click(document.querySelector('.confirm-btn.bad')!);
    expect(rejectInvite).toHaveBeenCalledTimes(1);
  });

  it('busy 期间两键全禁：接受在开局路上，此刻再点拒绝会把两局都开掉', () => {
    setup({}, { inviteBusy: true });
    expect(document.querySelector<HTMLButtonElement>('.confirm-btn.ok')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.confirm-btn.bad')!.disabled).toBe(true);
    expect(text()).toContain('正在开局');
  });
});

describe('回执态', () => {
  it('accepted + roomId：给「进入对局」，链接就是 pkRoomHash 那个形状（两处解析必须同源）', () => {
    setup({ status: 'accepted', roomId: 'R-9' });
    expect(text()).toContain('对战已开始');
    expect(href()).toBe(pkRoomHash('R-9'));
    expect(href()).toBe('#/pk?roomId=R-9');
    expect(document.querySelector('button.choice-dismiss')).toBeNull(); // 已开局不给「收起」入口
  });

  it('accepted 但 roomId 为 null（刷新后内存房已回收）：不许渲染出跳到 undefined 的链接', () => {
    setup({ status: 'accepted', roomId: null });
    expect(href()).toBeUndefined();
    expect(text()).not.toContain('roomId=undefined');
    // 退路仍是「收起」：这张卡已经进不去任何对局，留着只挡地方
    fireEvent.click(document.querySelector('button.choice-dismiss')!);
  });

  it('rejected：如实念「已拒绝」+ 留出「随时再打」的口子，且不再给接受按钮', () => {
    const { dismissInvite } = setup({ status: 'rejected' });
    expect(text()).toContain('这局不打了');
    expect(text()).toContain('想打可以随时再让它邀请一局');
    expect(document.querySelector('.confirm-btns')).toBeNull();
    fireEvent.click(document.querySelector('button.choice-dismiss')!);
    expect(dismissInvite).toHaveBeenCalledTimes(1);
  });
});
