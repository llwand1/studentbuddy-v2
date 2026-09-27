/**
 * speech.test — 朗读设置契约的回归锁（`normalizeSpeechSettings` / `speechSummary`）。
 *
 * 钉四件事：① 非法输入**逐字段回落默认**（绝不整体作废、绝不抛，ADR-6）；
 * ② `rate` **钳位**而非丢弃（拖过头存成边界，而不是把用户刚做的动作作废）；
 * ③ ★★ `voiceName` **刻意不做白名单**——音色候选是「这台机器装了什么语音包」的函数，
 *    服务端数不出来，故只做「字符串 + 不超长」的结构校验。这条是本文件与
 *    `answer-style.test.ts` 最大的不同，写成用例防止后人「顺手对齐」成白名单
 *    （那样会把「另一台机器上的音色」判成非法并静默清空）。
 * ④ 逐字段独立：一个字段坏不牵连另一个。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SPEECH_SETTINGS,
  SETTING_KEY_SPEECH,
  SPEECH_RATE_MAX,
  SPEECH_RATE_MIN,
  normalizeSpeechSettings,
  speechSummary,
} from './speech.js';

describe('normalizeSpeechSettings — 逐字段归一', () => {
  it('缺省 / 非对象 / null / 数组 都回默认（数据容错，绝不抛）', () => {
    for (const raw of [undefined, null, 42, 'x', [], true]) {
      expect(normalizeSpeechSettings(raw)).toEqual(DEFAULT_SPEECH_SETTINGS);
    }
    expect(normalizeSpeechSettings({})).toEqual(DEFAULT_SPEECH_SETTINGS);
  });

  it('★ 合法音色名原样保留（不做白名单——候选由本机决定，服务端认不出来也不能否掉）', () => {
    const name = 'Microsoft David - English (United States)';
    expect(normalizeSpeechSettings({ voiceName: name }).voiceName).toBe(name);
  });

  it('音色首尾空白 trim；空串／纯空白＝不指定（回落系统默认）', () => {
    expect(normalizeSpeechSettings({ voiceName: '  David  ' }).voiceName).toBe('David');
    expect(normalizeSpeechSettings({ voiceName: '   ' }).voiceName).toBe('');
  });

  it('★ 音色超长 → 回落空串（**不截断**：截出来的名字一定匹配不上任何真实音色）', () => {
    expect(normalizeSpeechSettings({ voiceName: 'x'.repeat(121) }).voiceName).toBe('');
    expect(normalizeSpeechSettings({ voiceName: 'x'.repeat(120) }).voiceName).toBe('x'.repeat(120));
  });

  it('非字符串 voiceName → 回落空串', () => {
    for (const v of [42, null, {}, true, []]) {
      expect(normalizeSpeechSettings({ voiceName: v }).voiceName).toBe('');
    }
  });

  it('★ rate 钳位：拖过头存成边界，而不是把用户刚做的动作作废', () => {
    expect(normalizeSpeechSettings({ rate: 99 }).rate).toBe(SPEECH_RATE_MAX);
    expect(normalizeSpeechSettings({ rate: 0 }).rate).toBe(SPEECH_RATE_MIN);
    expect(normalizeSpeechSettings({ rate: -3 }).rate).toBe(SPEECH_RATE_MIN);
  });

  it('★ rate 保留一位小数（滑条步进就是 0.1，库里不该出现浮点尾巴）', () => {
    expect(normalizeSpeechSettings({ rate: 1.03 }).rate).toBe(1);
    expect(normalizeSpeechSettings({ rate: 1.06 }).rate).toBe(1.1);
    expect(normalizeSpeechSettings({ rate: 1.5000001 }).rate).toBe(1.5);
  });

  it('非法 rate（NaN / Infinity / 字符串 / null）→ 回落 1', () => {
    for (const r of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1.5', null, {}, true]) {
      expect(normalizeSpeechSettings({ rate: r }).rate).toBe(1);
    }
  });

  it('★ 逐字段独立：一个字段坏不牵连另一个（不是整体作废）', () => {
    expect(normalizeSpeechSettings({ voiceName: 'David', rate: Number.NaN })).toEqual({
      voiceName: 'David',
      rate: 1,
    });
  });

  it('默认值语义＝本功能引入前的行为（空音色 + 1.0×）；setting key 固定', () => {
    expect(DEFAULT_SPEECH_SETTINGS).toEqual({ voiceName: '', rate: 1 });
    expect(SETTING_KEY_SPEECH).toBe('speech');
  });
});

describe('speechSummary — 设置卡状态行', () => {
  it('有音色显示音色名；没有则显示「系统默认英文音色」', () => {
    expect(speechSummary({ voiceName: 'David', rate: 1 })).toBe('David · 1.0×');
    expect(speechSummary({ voiceName: '', rate: 1.5 })).toBe('系统默认英文音色 · 1.5×');
  });
});
