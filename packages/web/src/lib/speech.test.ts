// @vitest-environment jsdom
/**
 * speech.test — 词条英文发音的回归锁（契约 `docs/TERM-HIGHLIGHT-SPEC.md` §3.1 / §9，v1.1）。
 *
 * 钉两层：
 *   ① **判定规则**（`isEnglishWord`）——纯函数零 DOM，逐类边界钉死。它同时决定「按钮出不出现」
 *      与「点了读什么」，判错就是「中文词条冒出个喇叭」或「英文词条没有喇叭」这种当场可见的错。
 *   ② **朗读路径**（`speakEnglish`）——`speechSynthesis` 全打桩（jsdom 没有这个 API）。
 *      重点不是「调没调 speak」，而是**三态里的失败态**：`canceled`/`interrupted` 是我们自己
 *      `cancel()` 的产物，被当成失败会让 UI 闪一条假报错，而真正的失败（系统没装英文语音）
 *      会被这条假报错淹没。
 *
 * ★ jsdom **不实现** `speechSynthesis`——所以「环境不支持」这条路径在默认环境里就是真的，
 *   不需要伪造（下面 `环境没有语音能力` 那组直接跑的就是它）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { canSpeak, isEnglishWord, speakEnglish } from './speech';

/** 测试里禁 `!` 非空断言（AGENTS.md 红线）：要断存在就写会抛错的辅助函数 */
function must<T>(v: T | null | undefined, what = '节点'): T {
  if (v === null || v === undefined) throw new Error(`找不到${what}`);
  return v;
}

/** `SpeechSynthesisUtterance` 的最小替身：只保留代码真正用到的四个成员 */
class FakeUtterance {
  text: string;
  lang = '';
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

let spoken: FakeUtterance | null = null;
const cancelMock = vi.fn();
const speakMock = vi.fn((u: FakeUtterance) => {
  spoken = u;
});

beforeEach(() => {
  spoken = null;
  cancelMock.mockClear();
  speakMock.mockClear();
  vi.stubGlobal('speechSynthesis', { cancel: cancelMock, speak: speakMock });
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isEnglishWord — 该不该给发音按钮', () => {
  it('英文术语判为真', () => {
    for (const w of ['closure', 'Closure', 'let', 'Node.js', 'low-poly', 'AI Agent', 'machine learning']) {
      expect(isEnglishWord(w)).toBe(true);
    }
  });

  it('首字符允许点号（`.NET` 这类真实术语）与数字（`3D`）', () => {
    expect(isEnglishWord('.NET')).toBe(true);
    expect(isEnglishWord('3D')).toBe(true);
  });

  it('中文词条判为假——不发音', () => {
    for (const w of ['闭包', '机器学习', '内存泄漏', 'C语言']) {
      expect(isEnglishWord(w)).toBe(false);
    }
  });

  it('★ 符号型词条判为假——读出来是噪音（`C++` 会被读成「C」）', () => {
    for (const w of ['C++', 'C#', 'A(B)', 'std::vector', 'foo@bar']) {
      expect(isEnglishWord(w)).toBe(false);
    }
  });

  it('纯数字 / 空值 / 只有标点判为假（`(?=.*[A-Za-z])` 保证至少一个字母）', () => {
    for (const w of ['123', '', '   ', '.', '...']) {
      expect(isEnglishWord(w)).toBe(false);
    }
  });

  it('首尾空白先 trim（正文切片可能带空格）', () => {
    expect(isEnglishWord('  closure  ')).toBe(true);
  });

  it('★ 长度上限 64：拦「整句英文被当词条朗读」，不是功能阈值', () => {
    expect(isEnglishWord('a'.repeat(64))).toBe(true);
    expect(isEnglishWord('a'.repeat(65))).toBe(false);
  });
});

describe('canSpeak — 能力探测', () => {
  it('打桩后为真（按钮的渲染前提之一）', () => {
    expect(canSpeak()).toBe(true);
  });

  it('★ 环境没有语音能力时为假——调用方据此**不渲染按钮**（不做假按钮）', () => {
    vi.unstubAllGlobals();
    expect(canSpeak()).toBe(false);
  });
});

describe('speakEnglish — 朗读路径与三态', () => {
  it('把文本与 en-US 交给朗读器，读完 resolve', async () => {
    const p = speakEnglish('closure');
    const u = must(spoken, '朗读请求');
    expect(u.text).toBe('closure');
    expect(u.lang).toBe('en-US');
    u.onend?.();
    await expect(p).resolves.toBeUndefined();
  });

  it('★ 每次朗读前先 cancel——不 cancel 会叠音（连点两次就是两句一起读）', () => {
    void speakEnglish('closure');
    expect(cancelMock).toHaveBeenCalled();
  });

  it('★ canceled / interrupted 不算失败（那是自己 cancel 的产物，含快速切词的自我打断）', async () => {
    const p = speakEnglish('closure');
    must(spoken, '朗读请求').onerror?.({ error: 'canceled' });
    await expect(p).resolves.toBeUndefined();

    const p2 = speakEnglish('closure');
    must(spoken, '朗读请求').onerror?.({ error: 'interrupted' });
    await expect(p2).resolves.toBeUndefined();
  });

  it('★ 真错误 reject 并带用户可读文案（系统没装英文语音时会静默无声，必须说出来）', async () => {
    const p = speakEnglish('closure');
    must(spoken, '朗读请求').onerror?.({ error: 'synthesis-failed' });
    await expect(p).rejects.toThrow('朗读失败');
  });

  it('环境不支持时直接 reject（调用方本就该不渲染按钮，这是第二道防线）', async () => {
    vi.unstubAllGlobals();
    await expect(speakEnglish('closure')).rejects.toThrow('不支持');
  });
});
