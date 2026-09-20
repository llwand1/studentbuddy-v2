/**
 * image-intake.test — 待发送图片「收编判定」的纯函数回归锁。
 *
 * 钉三件事：
 * ① 超限的两条路（单张过大 / 张数已满）各自可判，且边界取「等于上限＝收」；
 * ② 名额必须把「读取中」的张数算进来——同一 tick 连续两次粘贴各 3 张曾实测落进 6 张
 *    （v0.2.69 修过，这里锁住它的算法前提，防后人把 inflight 从那行里摘掉）；
 * ③ 被拒必须给得出人话且**不静默**（ADR-5：用户以为选上了却不见图，比报错更糟）。
 *
 * 判定层是纯函数，故本文件零 DOM、零 FileReader（组件侧接线的锁在 ChatComposer.test.tsx）。
 */
import { describe, it, expect } from 'vitest';
import { MAX_CHAT_IMAGES, MAX_IMAGE_DATAURL_CHARS } from '@sb/shared';
import { judgeLoadedImage, remainingSlots, intakeRejectHint } from './image-intake';

describe('judgeLoadedImage（读完之后收不收）', () => {
  it('正常尺寸、名额未满 → 收', () => {
    expect(judgeLoadedImage('data:image/png;base64,AAAA', 0)).toBe('accept');
  });

  it('恰好等于单张上限 → 收（边界取闭区间，与 chat-limits 的「≤上限」同口径）', () => {
    const atLimit = 'A'.repeat(MAX_IMAGE_DATAURL_CHARS);
    expect(judgeLoadedImage(atLimit, 0)).toBe('accept');
  });

  it('超单张上限一个字符 → 拒，理由是 too-large', () => {
    const over = 'A'.repeat(MAX_IMAGE_DATAURL_CHARS + 1);
    expect(judgeLoadedImage(over, 0)).toBe('too-large');
  });

  it('名额已满 → 拒，理由是 full', () => {
    expect(judgeLoadedImage('data:image/png;base64,AAAA', MAX_CHAT_IMAGES)).toBe('full');
  });

  it('过大与满同时成立时判「过大」优先（用户该先知道是这张图不行）', () => {
    const over = 'A'.repeat(MAX_IMAGE_DATAURL_CHARS + 1);
    expect(judgeLoadedImage(over, MAX_CHAT_IMAGES)).toBe('too-large');
  });
});

describe('remainingSlots（名额要把读取中算进来）', () => {
  it('空托盘、无在途 → 满额可用', () => {
    expect(remainingSlots(0, 0)).toBe(MAX_CHAT_IMAGES);
  });

  it('已收 + 读取中一起扣，这才是同一 tick 连粘不越线的算法前提', () => {
    expect(remainingSlots(2, 1)).toBe(MAX_CHAT_IMAGES - 3);
  });

  it('超出时钳到 0，不返回负数（负数会让 slice(0, room) 悄悄切成空数组）', () => {
    expect(remainingSlots(MAX_CHAT_IMAGES, 0)).toBe(0);
    expect(remainingSlots(MAX_CHAT_IMAGES + 3, 5)).toBe(0);
  });
});

describe('intakeRejectHint（被拒要说人话，不许静默）', () => {
  it('过大：报张数 + 上限体积（给用户看 MB，不给内部字符数）', () => {
    const s = intakeRejectHint('too-large', 2);
    expect(s).toContain('2 张');
    expect(s).toMatch(/MB/);
  });

  it('满了：报一次最多几张', () => {
    expect(intakeRejectHint('full', 1)).toContain(String(MAX_CHAT_IMAGES));
  });

  it('两种原因文案不同（否则用户无从判断该压缩还是该少选）', () => {
    expect(intakeRejectHint('too-large', 1)).not.toBe(intakeRejectHint('full', 1));
  });
});
