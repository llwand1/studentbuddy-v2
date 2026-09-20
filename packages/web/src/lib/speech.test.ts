// @vitest-environment jsdom
/**
 * speech.test — 词条英文发音的回归锁（契约 `docs/TERM-HIGHLIGHT-SPEC.md` §3.1 / §9，v1.1）。
 *
 * 钉三层：
 *   ① **判定规则**（`isEnglishWord`）——纯函数零 DOM，逐类边界钉死。它同时决定「按钮出不出现」
 *      与「点了读什么」，判错就是「中文词条冒出个喇叭」或「英文词条没有喇叭」这种当场可见的错。
 *   ② **朗读路径**（`speakEnglish`）——`speechSynthesis` 全打桩（jsdom 没有这个 API）。
 *      重点不是「调没调 speak」，而是**三态里的失败态**：`canceled`/`interrupted` 是我们自己
 *      `cancel()` 的产物，被当成失败会让 UI 闪一条假报错，而真正的失败（系统没装英文语音）
 *      会被这条假报错淹没。
 *   ③ **音色 / 语速注入**（本版新增，契约 `shared/src/speech.ts`）——设置值必须真落到
 *      utterance 上；音色在本机不存在时**回落系统默认而不是朗读失败**；候选只收英文音色。
 *
 * ★ jsdom **不实现** `speechSynthesis` —— 三件成员（`speak` / `cancel` / `getVoices`）全部打桩；
 *   「环境不支持」那条路径在默认环境里就是真的，不需要伪造（`环境没有语音能力` 那组直接跑它）。
 * ★ **本版起 `speakEnglish` 是 async**（要先 `await` 一次「取设置」）⇒ 断言 utterance 之前
 *   必须让出任务队列，否则拿到的是 `null`。统一走 `until()`（轮询而非固定等一次，避免
 *   因为 await 次数变化而变成偶发红）。`beforeEach` 预热设置缓存 ⇒ 命中缓存不打真实 HTTP。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  canSpeak,
  englishVoices,
  isEnglishWord,
  pickVoice,
  setSpeechSettingsCache,
  speakEnglish,
} from './speech';

/** 测试里禁 `!` 非空断言（AGENTS.md 红线）：要断存在就写会抛错的辅助函数 */
function must<T>(v: T | null | undefined, what = '节点'): T {
  if (v === null || v === undefined) throw new Error(`找不到${what}`);
  return v;
}

/**
 * 取本轮朗读请求（不存在即抛错）。
 *
 * ★ 刻意**在函数内**读 `spoken`，而不是让用例直接写 `must(spoken, …)`：
 * `spoken = null` 之后再赋值时，TS 会把变量窄化成 `null`（它看不见 `until()` 里回调的赋值），
 * 于是 `must()` 推出 `T = null`、`.onerror` 报 `Object is possibly 'null'` ——
 * **是编译期的窄化误判，跟运行期无关**（vitest 不做类型检查，故测试全绿而 tsc 红）。
 * 走一层函数读，窄化信息不进函数体，值就是 `FakeUtterance | null`。
 */
function lastUtterance(): FakeUtterance {
  return must(spoken, '朗读请求');
}

/** `SpeechSynthesisUtterance` 的最小替身：只保留代码真正用到的成员 */
class FakeUtterance {
  text: string;
  lang = '';
  rate = 1;
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

let spoken: FakeUtterance | null = null;
/** 本机「已安装」的音色（`englishVoices` 的来源），每条用例按需设置 */
let voices: Array<{ name: string; lang: string }> = [];
const cancelMock = vi.fn();
const speakMock = vi.fn((u: FakeUtterance) => {
  spoken = u;
});
const getVoicesMock = vi.fn(() => voices);

/** 让出任务队列一次（`speakEnglish` 内部有一次 `await` 取设置） */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 反复让出直到条件成立（轮询而非「固定等 N 次」，这样 await 次数变化也不会变脆） */
async function until(cond: () => boolean, tries = 20): Promise<void> {
  for (let i = 0; i < tries && !cond(); i += 1) await flush();
}

beforeEach(() => {
  spoken = null;
  voices = [];
  cancelMock.mockClear();
  speakMock.mockClear();
  getVoicesMock.mockClear();
  vi.stubGlobal('speechSynthesis', { cancel: cancelMock, speak: speakMock, getVoices: getVoicesMock });
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  // 预热设置缓存：命中缓存 ⇒ `resolveSpeechSettings` 直接返回，不打真实 HTTP
  setSpeechSettingsCache({ voiceName: '', rate: 1 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSpeechSettingsCache(null);
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
    await until(() => spoken !== null);
    const u = lastUtterance();
    expect(u.text).toBe('closure');
    expect(u.lang).toBe('en-US');
    u.onend?.();
    await expect(p).resolves.toBeUndefined();
  });

  it('★ 每次朗读前先 cancel——不 cancel 会叠音（连点两次就是两句一起读）', async () => {
    const p = speakEnglish('closure');
    // ★ cancel 必须**同步**就发生（排在 await 取设置之前）：排在后面会让上一句多活一个
    //   往返，听起来正是连点时的前半声叠音 ⇒ 这条断言刻意**不让出任务队列**就打
    expect(cancelMock).toHaveBeenCalled();
    await until(() => spoken !== null);
    lastUtterance().onend?.();
    await p;
  });

  it('★ canceled / interrupted 不算失败（那是自己 cancel 的产物，含快速切词的自我打断）', async () => {
    const p = speakEnglish('closure');
    await until(() => spoken !== null);
    lastUtterance().onerror?.({ error: 'canceled' });
    await expect(p).resolves.toBeUndefined();

    spoken = null;
    const p2 = speakEnglish('closure');
    await until(() => spoken !== null);
    lastUtterance().onerror?.({ error: 'interrupted' });
    await expect(p2).resolves.toBeUndefined();
  });

  it('★ 真错误 reject 并带用户可读文案（系统没装英文语音时会静默无声，必须说出来）', async () => {
    const p = speakEnglish('closure');
    await until(() => spoken !== null);
    lastUtterance().onerror?.({ error: 'synthesis-failed' });
    await expect(p).rejects.toThrow('朗读失败');
  });

  it('环境不支持时直接 reject（调用方本就该不渲染按钮，这是第二道防线）', async () => {
    vi.unstubAllGlobals();
    await expect(speakEnglish('closure')).rejects.toThrow('不支持');
  });
});

describe('音色与语速注入 — 设置真的落到朗读上', () => {
  it('★ 语速落到 utterance 上（设置里调了语速，朗读就必须跟着变）', async () => {
    setSpeechSettingsCache({ voiceName: '', rate: 1.5 });
    const p = speakEnglish('closure');
    await until(() => spoken !== null);
    expect(lastUtterance().rate).toBe(1.5);
    lastUtterance().onend?.();
    await p;
  });

  it('★ 选中的音色在本机存在 → 挂到 utterance 上', async () => {
    const david = { name: 'Microsoft David - English (United States)', lang: 'en-US' };
    voices = [david];
    setSpeechSettingsCache({ voiceName: david.name, rate: 1 });
    const p = speakEnglish('closure');
    await until(() => spoken !== null);
    expect(lastUtterance().voice).toEqual(david);
    lastUtterance().onend?.();
    await p;
  });

  it('★★ 音色在本机不存在 → **什么都不设**（回落系统默认），绝不因此朗读失败', async () => {
    // 设置是从服务端同步过来的：它可能来自**另一台机器**，那个音色这台没装
    voices = [{ name: 'Microsoft Zira - English (United States)', lang: 'en-US' }];
    setSpeechSettingsCache({ voiceName: 'Microsoft David - English (United States)', rate: 1 });
    const p = speakEnglish('closure');
    await until(() => spoken !== null);
    const u = lastUtterance();
    expect(u.voice).toBeNull(); // 没设 ⇒ 浏览器按 lang 自挑一把
    u.onend?.();
    await expect(p).resolves.toBeUndefined();
  });

  it('本机一个英文音色都没有 → 同样不设 voice，照常朗读', async () => {
    voices = [];
    setSpeechSettingsCache({ voiceName: 'whatever', rate: 1 });
    const p = speakEnglish('closure');
    await until(() => spoken !== null);
    expect(lastUtterance().voice).toBeNull();
    lastUtterance().onend?.();
    await expect(p).resolves.toBeUndefined();
  });

  it('★ 缓存为空且设置拉不到 → 回落默认照读（离线/未登录不该让喇叭哑掉）', async () => {
    setSpeechSettingsCache(null); // 强制走「拉一次设置」的路径（测试环境里这次请求必然失败）
    const p = speakEnglish('closure');
    await until(() => spoken !== null);
    const u = lastUtterance();
    expect(u.rate).toBe(1); // 默认语速
    expect(u.voice).toBeNull(); // 默认不指定音色
    u.onend?.();
    await expect(p).resolves.toBeUndefined();
  });
});

describe('englishVoices / pickVoice — 音色候选与匹配', () => {
  it('★ 只收英文音色（中文/日文音色配英文词条的喇叭是不存在的场景，列出来只让用户白选）', () => {
    voices = [
      { name: 'A', lang: 'en-US' },
      { name: 'B', lang: 'en-GB' },
      { name: 'C', lang: 'zh-CN' },
      { name: 'D', lang: 'ja-JP' },
    ];
    expect(englishVoices().map((v) => v.name)).toEqual(['A', 'B']);
  });

  it('★ 语言标签大小写不敏感（`EN-US` 这种也要认）', () => {
    voices = [{ name: 'A', lang: 'EN-US' }];
    expect(englishVoices().map((v) => v.name)).toEqual(['A']);
  });

  it('pickVoice 按名精确匹配；名字为空或找不到都返回 null（⇒ 回落系统默认）', () => {
    voices = [{ name: 'A', lang: 'en-US' }];
    expect(pickVoice('A')).toEqual(voices[0]);
    expect(pickVoice('Z')).toBeNull();
    expect(pickVoice('')).toBeNull();
  });

  it('环境不支持时返回空列表 / null（不抛错）', () => {
    vi.unstubAllGlobals();
    expect(englishVoices()).toEqual([]);
    expect(pickVoice('A')).toBeNull();
  });
});
