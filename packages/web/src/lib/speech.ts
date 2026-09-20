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
 * 朗读一段英文。成功（读完）resolve；失败 reject 并带**用户可读**的 message
 * （调用方直接把它填进卡片的提示行——`AGENTS.md` 红线 5：三态里的失败必须说出来）。
 *
 * ★ **每次朗读前先 `cancel()`**：不取消会叠音——连点两次就是两句一起读。
 * ★ **`canceled` / `interrupted` 不算失败**：它们正是上面那句 `cancel()` 的产物
 *   （含用户快速切词时的自我打断）。当失败处理会让 UI 闪一条假报错，
 *   而真正的失败（系统没装英文语音）会被这条假报错淹没。
 */
export function speakEnglish(text: string): Promise<void> {
  if (!canSpeak()) return Promise.reject(new Error('当前浏览器不支持语音朗读'));

  const synth = window.speechSynthesis;
  synth.cancel();

  return new Promise<void>((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(text);
    // 固定 en-US：本按钮只在 `isEnglishWord` 为真时出现，语种没有第二种可能，
    // 不做「按词条猜语种」——那需要词条带语种字段，而 TermItem 没有（契约 §3.1）
    u.lang = 'en-US';
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
