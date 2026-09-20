/**
 * chat-limits.test — 「三笔限额的账必须平」的回归锁。
 *
 * 为什么值得一个独立测试文件：这三笔数字（张数 / 单张字符数 / body 上限）此前分散在三个包
 * 各写一遍，每处注释都写着「与另一处是同一套账」——而**靠注释维持的账本实测已经不平**：
 * 单张 700 万字符 × 4 张 ≈ 28MB > 24mb body，即「4 张各自合法的图一起发会撞 413」，
 * 且 413 发生在路由之前 ⇒ 用户看到的是「点发送没反应」这种最难定位的症状。
 *
 * 本文件把「账」变成可执行断言：任何人把单张上限调大而不动 body 限额，第一条直接红。
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_CHAT_IMAGES,
  MAX_IMAGE_DATAURL_CHARS,
  CHAT_BODY_LIMIT,
  CHAT_BODY_LIMIT_BYTES,
  worstCaseChatBodyBytes,
  maxImageSizeHint,
} from './chat-limits.js';

describe('chat-limits 的三笔账', () => {
  it('账必须平：满额图片请求装得进 body 限额（本文件存在的理由）', () => {
    expect(worstCaseChatBodyBytes()).toBeLessThan(CHAT_BODY_LIMIT_BYTES);
  });

  it('且要有余量，不是贴着线过（贴线过＝下一个人加一个字段就撞）', () => {
    // 至少留 2MB 给「除图片外的其它字段稍有增长」
    expect(CHAT_BODY_LIMIT_BYTES - worstCaseChatBodyBytes()).toBeGreaterThan(2 * 1024 * 1024);
  });

  it('反向取证：旧值（单张 700 万，2026-09-20 前）代进同一公式会超 —— 证明上面那条真拦得住', () => {
    const legacyWorstCase = MAX_CHAT_IMAGES * 7_000_000 + 20_000;
    expect(legacyWorstCase).toBeGreaterThan(CHAT_BODY_LIMIT_BYTES);
  });

  it('常量自身合法：张数为正整数、单张上限为正、body 字面量与字节数同口径', () => {
    expect(Number.isInteger(MAX_CHAT_IMAGES)).toBe(true);
    expect(MAX_CHAT_IMAGES).toBeGreaterThan(0);
    expect(MAX_IMAGE_DATAURL_CHARS).toBeGreaterThan(0);
    // '24mb' 与 24*1024*1024 必须一致（express 按 1024 进制解释）
    expect(CHAT_BODY_LIMIT).toBe('24mb');
    expect(CHAT_BODY_LIMIT_BYTES).toBe(24 * 1024 * 1024);
  });

  it('满额估算随张数线性增长（防有人把张数上限调成 0 或漏乘）', () => {
    expect(worstCaseChatBodyBytes()).toBeGreaterThanOrEqual(MAX_CHAT_IMAGES * MAX_IMAGE_DATAURL_CHARS);
  });

  it('给用户看的体积文案是「约 N MB」而不是内部字符数', () => {
    expect(maxImageSizeHint()).toMatch(/^约 \d+\.\dMB$/);
  });
});
