// @vitest-environment jsdom
/**
 * SpeechCard.test — 词条朗读设置卡的渲染层锁（本仓 `features/settings/` 的**首个**组件测试）。
 *
 * 钉五件事：
 *   ① 渲染服务端读回的音色与语速；② 音色候选来自**本机枚举**且恒有「系统默认」一项
 *   （服务端不知道候选集，见 `shared/src/speech.ts` 头注）；
 *   ③ 改音色**立即落库**——改了不存＝用户以为设了其实没设；
 *   ④ ★ 试听前把**屏上当前值**塞进朗读缓存：拿已落库的旧值试听，用户会以为滑条坏了；
 *   ⑤ 浏览器不支持语音时**不渲染控件**、只给一句说明（同「不做假按钮」的纪律：不做假控件）。
 *
 * ★ `lib/api` 与 `lib/speech` 两个模块整体替身：本文件测的是**卡片的编排**
 *   （读到什么、点了发什么），不是发音实现（那由 `lib/speech.test.ts` 覆盖）。
 *   `speechSynthesis` **不打桩**——jsdom 里它本来就是 `undefined`，而卡片对它是
 *   `window.speechSynthesis?.addEventListener(...)` 的可选链访问，正好顺带证明这条路径不会抛。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SPEECH_SETTINGS } from '@sb/shared';

const h = vi.hoisted(() => ({
  speakable: true,
  voices: [] as Array<{ name: string; lang: string }>,
  getSpeech: vi.fn(),
  saveSpeech: vi.fn(),
  resetSpeech: vi.fn(),
  setCache: vi.fn(),
  speak: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  api: {
    settings: { speech: h.getSpeech, saveSpeech: h.saveSpeech, resetSpeech: h.resetSpeech },
  },
}));

vi.mock('../../lib/speech', () => ({
  canSpeak: () => h.speakable,
  englishVoices: () => h.voices,
  setSpeechSettingsCache: h.setCache,
  speakEnglish: h.speak,
}));

import { SpeechCard } from './SpeechCard';

const flash = vi.fn();

/**
 * ★ **必须显式 cleanup**：RTL 的自动清理是通过注册全局 `afterEach` 实现的，而本仓
 *   `vitest.config.ts` **没有开 `globals`** ⇒ 自动清理不会生效，上一个用例的 DOM 会留在
 *   `document` 里，下一个用例的 `getByText` 立刻报「找到多个元素」（症状极像选择器写错）。
 *   写成文件内的 `afterEach(cleanup)`，比去改全局配置安全（不动别人的测试）。
 */
afterEach(cleanup);

beforeEach(() => {
  h.speakable = true;
  h.voices = [];
  h.getSpeech.mockReset().mockResolvedValue({ settings: DEFAULT_SPEECH_SETTINGS });
  h.saveSpeech
    .mockReset()
    .mockImplementation((s: unknown) => Promise.resolve({ ok: true, settings: s }));
  h.resetSpeech.mockReset().mockResolvedValue({ settings: DEFAULT_SPEECH_SETTINGS });
  h.setCache.mockReset();
  h.speak.mockReset().mockResolvedValue(undefined);
  flash.mockReset();
});

describe('SpeechCard — 词条朗读设置卡', () => {
  it('渲染服务端读回的音色与语速', async () => {
    h.getSpeech.mockResolvedValue({ settings: { voiceName: '', rate: 1.5 } });
    render(<SpeechCard flash={flash} />);
    await waitFor(() => expect(screen.getByText('1.5×')).toBeTruthy());
  });

  it('★ 音色候选来自本机枚举，且恒有「系统默认英文音色」一项', async () => {
    h.voices = [{ name: 'David', lang: 'en-US' }];
    render(<SpeechCard flash={flash} />);
    await waitFor(() => expect(screen.getByText('系统默认英文音色')).toBeTruthy());
    expect(screen.getByText('David（en-US）')).toBeTruthy();
  });

  it('★ 改音色 → 立即调 saveSpeech（改了不存＝用户以为设了其实没设）', async () => {
    h.voices = [{ name: 'David', lang: 'en-US' }];
    render(<SpeechCard flash={flash} />);
    await waitFor(() => expect(screen.getByText('David（en-US）')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('音色'), { target: { value: 'David' } });
    await waitFor(() => expect(h.saveSpeech).toHaveBeenCalledWith({ voiceName: 'David', rate: 1 }));
  });

  it('★ 试听把「屏上当前值」塞进朗读缓存（用旧值试听会让用户以为滑条坏了）', async () => {
    render(<SpeechCard flash={flash} />);
    await waitFor(() => expect(h.getSpeech).toHaveBeenCalled());
    fireEvent.click(screen.getByText('试听'));
    await waitFor(() => expect(h.speak).toHaveBeenCalled());
    expect(h.setCache).toHaveBeenCalledWith(DEFAULT_SPEECH_SETTINGS);
  });

  it('★ 浏览器不支持语音 → 不渲染控件、只给说明（不做假控件）', async () => {
    h.speakable = false;
    render(<SpeechCard flash={flash} />);
    await waitFor(() => expect(screen.getByText(/不支持语音朗读/)).toBeTruthy());
    expect(screen.queryByLabelText('音色')).toBeNull();
    expect(screen.queryByLabelText('语速')).toBeNull();
    expect(screen.queryByText('试听')).toBeNull();
  });

  it('恢复默认 → 调 resetSpeech 并回落默认值', async () => {
    render(<SpeechCard flash={flash} />);
    await waitFor(() => expect(h.getSpeech).toHaveBeenCalled());
    fireEvent.click(screen.getByText('恢复默认'));
    await waitFor(() => expect(h.resetSpeech).toHaveBeenCalled());
  });
});
