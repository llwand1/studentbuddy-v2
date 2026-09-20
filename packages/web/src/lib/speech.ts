/**
 * speech — 词条英文发音（契约 `docs/TERM-HIGHLIGHT-SPEC.md` §3.1 / §6，v1.1）。
 *
 * ★ **为什么放 `lib/` 而不是 `features/chat/`**：本模块只吃一个字符串，既不认识词条、
 *   也不认识卡片，放 chat 目录等于用目录结构谎称它属于对话页（将来词条库页要用就得
 *   跨 feature import）。它是通用工具，只是当前唯一调用方在对话页。
 *
 * ★ **判定与朗读共用同一个输入**（正文里显示的那段文本，由 `TermText` 的 `data-say` 注入）：
 *   别名命中时正文显示 `closure`、而 `item.term` 是 `闭包`——拿后者判定会**漏掉按钮**，
 *   拿后者朗读会**用英文语音读中文**。契约 §3.1 已记账，这是本版最容易做错的一处。
 *
 * ★ **不支持时由调用方不渲染按钮**（`canSpeak()` 为假），而不是渲染一个点了才报错的按钮
 *   ——同契约 §6「不做假按钮」：点了一定失败的按钮比没有按钮更糟。
 *
 * ★ **引擎取浏览器本地语音**（`speechSynthesis`）：零依赖、零联网、离线可用，与本项目
 *   「本地优先」定位同向。契约 §0 已记账为何不选在线真人音（联网/第三方非契约接口/离线不可用，
 *   而发音在本功能里是辅助手段而非内容本身，音质不构成选型理由）。
 */

import { api } from './api.js';
import { DEFAULT_SPEECH_SETTINGS, normalizeSpeechSettings } from '@sb/shared';
import type { SpeechSettings } from '@sb/shared';

/**
 * 英语词判定：**至少一个拉丁字母**，且只由拉丁字母 / 数字 / 撇号 / 连字符 / 点 / 空格构成。
 *
 * 首字符允许点号是为了 `.NET` 这类真实术语；`(?=.*[A-Za-z])` 则保证纯数字（`123`）不算英语词。
 */
const ENGLISH_WORD = /^(?=.*[A-Za-z])[A-Za-z0-9.][A-Za-z0-9'’\-. ]*$/;

/**
 * 判定「这段文本该不该给发音按钮」。
 *
 * ★ **64 是防御性上限、不是功能阈值**：词条是 AI 抽取出来的短术语，64 远高于任何真实词条；
 *   它唯一的职责是拦住「万一某条词条是一整句英文」时被整句朗读这种荒唐情况。
 *   **别把它当「多长的词算术语」引用，也别基于它做产品判断。**
 *
 * ★ 纯中文 / 日文词条返回 `false`（不发音）；`C++` / `C#` / `A(B)` 这类符号型也返回 `false`
 *   ——读出来是噪音（`C++` 会被读成「C」），给了按钮反而误导用户。
 */
export function isEnglishWord(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 64 && ENGLISH_WORD.test(t);
}

/**
 * 环境是否具备语音能力。
 *
 * ★ 调用方拿它决定**渲不渲染按钮**；`jsdom` 里没有 `speechSynthesis`，所以测试必须打桩
 *   （见 `speech.test.ts` 与 `TermText.test.tsx`）。
 */
export function canSpeak(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance !== 'undefined'
  );
}

/**
 * 本机可用的**英文**音色（设置卡下拉的候选来源）。
 *
 * ★ 为什么只筛 `lang` 前缀：本按钮只在 `isEnglishWord` 为真时出现，语种没有第二种可能；
 *   把中文/日文音色也列出来，用户选中后用英文语音读中文词是不可能的（那个按钮压根不出现），
 *   等于给了一堆选了没用的选项。
 * ★ **服务端不知道这份列表**：它是「这台机器装了什么语音包」的函数，故设置里存的是
 *   音色**名字**、合法性由客户端判（见 `shared/src/speech.ts` 头注）。
 */
export function englishVoices(): SpeechSynthesisVoice[] {
  if (!canSpeak()) return [];
  return window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'));
}

/**
 * 按名字取音色；找不到（本机没装 / 系统更新后名字变了 / 名字为空）返回 `null`。
 * ★ 返回 `null` 时调用方**不设 `u.voice`**，浏览器会按 `lang='en-US'` 自己挑一把
 *   ——即「回落系统默认」，而不是让朗读失败。设置里那个名字属于**另一台机器**时，
 *   正确的行为是照常读出来，不是弹一句「音色不存在」。
 */
export function pickVoice(name: string): SpeechSynthesisVoice | null {
  if (!name) return null;
  return englishVoices().find((v) => v.name === name) ?? null;
}

/**
 * 朗读设置的内存缓存。
 * ★ **为什么要缓存**：朗读是高频低延迟动作（连点几个词条），每次现拉一遍设置会给
 *   「点一下就出声」平白加一次网络往返；而设置极少改（只在设置页改）。
 * ★ **为什么不为它造 React context**：唯一消费方是 `speakEnglish` 内部，造 provider 就得在
 *   `App.tsx` 接线——为一个小组件去动集成点不划算。模块级缓存的代价是「多个标签页时，
 *   另一个标签改了设置、这个标签要等下次刷新才更新」，对本功能完全可以接受。
 */
let cached: SpeechSettings | null = null;

/** 设置页保存成功 / 恢复默认后调它，让下一次朗读立刻生效（不必等缓存失效） */
export function setSpeechSettingsCache(s: SpeechSettings | null): void {
  cached = s;
}

/**
 * 取朗读设置：有缓存用缓存，没有就拉一次。
 * ★ **拉不到不阻塞朗读**（回落默认）：离线、未登录、服务端抽风都不该让喇叭哑掉——
 *   朗读是纯客户端能力，设置只决定「用哪把嗓子」，不构成前提条件。
 */
async function resolveSpeechSettings(): Promise<SpeechSettings> {
  if (cached) return cached;
  try {
    const r = await api.settings.speech();
    cached = normalizeSpeechSettings(r.settings);
  } catch {
    cached = { ...DEFAULT_SPEECH_SETTINGS };
  }
  return cached;
}

/**
 * 朗读一段英文。成功（读完）resolve；失败 reject 并带**用户可读**的 message
 * （调用方直接把它填进卡片的提示行——`AGENTS.md` 红线 5：三态里的失败必须说出来）。
 *
 * ★ **音色与语速取自设置**（设置页可改，契约 `shared/src/speech.ts`）：本函数从模块缓存
 *   取一次，缓存空了才拉接口；拉不到就用默认值照读——**设置拉不到不该让喇叭哑掉**。
 *
 * ★ **每次朗读前先 `cancel()`**：不取消会叠音——连点两次就是两句一起读。
 *   ★ 那一句 `cancel()` **排在 `await` 取设置之前**：cancel 是「立刻闭嘴」的语义，
 *   排在后面会让上一句多活一个往返，听起来正是连点时的前半声叠音。
 * ★ **`canceled` / `interrupted` 不算失败**：它们正是上面那句 `cancel()` 的产物
 *   （含用户快速切词时的自我打断）。当失败处理会让 UI 闪一条假报错，
 *   而真正的失败（系统没装英文语音）会被这条假报错淹没。
 */
export async function speakEnglish(text: string): Promise<void> {
  if (!canSpeak()) throw new Error('当前浏览器不支持语音朗读');

  const synth = window.speechSynthesis;
  synth.cancel();

  const settings = await resolveSpeechSettings();

  return new Promise<void>((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(text);
    // 固定 en-US：本按钮只在 `isEnglishWord` 为真时出现，语种没有第二种可能，
    // 不做「按词条猜语种」——那需要词条带语种字段，而 TermItem 没有（契约 §3.1）
    u.lang = 'en-US';
    // rate 已由 shared 归一化钳在 0.5–2.0，不会落进引擎的严重失真区
    u.rate = settings.rate;
    // ★ 音色**找不到时什么都不设**（不是设成空串/undefined）：不设时浏览器按 `lang`
    //   自行挑一把（＝回落系统默认），把「换了台机器、那台没装这个语音包」这件正常事
    //   照常读出来，而不是变成一次失败。
    const v = pickVoice(settings.voiceName);
    if (v) u.voice = v;
    u.onend = () => resolve();
    u.onerror = (e) => {
      if (e.error === 'canceled' || e.error === 'interrupted') {
        resolve();
        return;
      }
      reject(new Error('朗读失败，请检查系统是否安装了英文语音'));
    };
    synth.speak(u);
  });
}
