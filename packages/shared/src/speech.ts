/**
 * speech — 词条英文发音的**设置契约**（音色 / 语速）。
 *
 * ★ **本文件为什么存在**：朗读能力在 `web/src/lib/speech.ts`（浏览器 `speechSynthesis`），
 *   而「用哪把嗓子、读多快」是**用户偏好**——要落 `app_settings`、要在设置页可改。
 *   偏好一旦有了默认值与归一化，就必须是**双端唯一事实源**：前端画控件、服务端校验落库
 *   各写一份，必然漂成「屏上选 A、库里存 B」（同 ANSWER-STYLE-SPEC 的既有教训）。
 *
 * ★★ **与 `answer-style.ts` 的关键差异：`voiceName` 不能做白名单校验。**
 *   回答方式的选项是项目自己定义的固定枚举（前后端都数得出来），而**音色来自浏览器
 *   `speechSynthesis.getVoices()`——它是「这台机器装了什么语音包」的函数**：
 *   服务端不可能知道有哪几个候选（同一账号在公司与家里的候选集就不同，甚至同一台机器
 *   在系统更新语音包后也会变）。⇒ 服务端**只做结构校验**（是字符串 + 不超长），
 *   合法性判定留给客户端；客户端在本机找不到该音色时**回落系统默认**（见 `pickVoice`），
 *   而不是让整份设置作废。
 *   ★ 也正因如此，**默认值取空串**（＝不指定，交给浏览器按 `lang` 挑），而不是写死一个
 *     `'Microsoft David'` 之类的具体名字——那个名字在别人机器上不一定存在。
 *
 * ★ **数据容错**（ADR-6）：非法 / 缺失 / 非对象输入一律**逐字段回落默认**，绝不整体丢弃、绝不抛错。
 */

export interface SpeechSettings {
  /**
   * 音色：浏览器 `SpeechSynthesisVoice.name`（如 `Microsoft David - English (United States)`）。
   * 空串＝**不指定**，由浏览器按 `lang='en-US'` 自行挑一把英文嗓子（＝本功能引入前的默认行为）。
   */
  voiceName: string;
  /** 语速倍率，`SPEECH_RATE_MIN`–`SPEECH_RATE_MAX`（`1` ＝正常速度）。 */
  rate: number;
}

/** 设置键（落 `app_settings`，与 `answer_style` / `quiz_mix` / `quiz_image` 同级，**每用户一份**） */
export const SETTING_KEY_SPEECH = 'speech';

/**
 * 语速区间：0.5× 慢速便于跟读 → 2.0× 快速复习。
 * ★ 区间不是随手取的：`SpeechSynthesisUtterance.rate` 超出这个范围后引擎会**严重失真**
 *   （0.1× 变成拖长的怪声、3× 只剩气音），可辨性比「范围大」重要。
 */
export const SPEECH_RATE_MIN = 0.5;
export const SPEECH_RATE_MAX = 2;
/** 滑条步进。与 `normalizeSpeechSettings` 的「保留一位小数」是同一个精度口径。 */
export const SPEECH_RATE_STEP = 0.1;

/** 默认 ＝ 本功能引入之前的行为：系统默认英文嗓子 + 正常语速（不设置即无任何变化） */
export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = { voiceName: '', rate: 1 };

/**
 * `voiceName` 长度上限。★ **纯防御，不是功能阈值**——真实语音名远短于此
 * （最长的一档也就六七十字符）；它唯一的职责是拦住「一整段文本被塞进音色字段」这种
 * 荒唐输入。别把它当「多长的音色名算合法」引用，也别基于它做产品判断。
 */
const VOICE_NAME_MAX = 120;

/** 语速保留一位小数：滑条步进就是 0.1，库里不该出现 `1.0300000000000002` 这种浮点尾巴。 */
function roundRate(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * 逐字段归一：非法 / 缺失各自回落该字段默认值，绝不整体丢弃、绝不抛错。
 *
 * ★ 语速用**钳位**而非丢弃：用户拖到 2.5 应当存成上限 2，而不是把他刚做的动作作废
 *   （同 `setQuizMix` 的钳位口径）。
 * ★ 音色超长时也回落默认而**不截断**——截断出来的名字一定匹配不上任何真实音色，
 *   留一个「看起来很像但永远选不中」的值比直接回落更难排查。
 */
export function normalizeSpeechSettings(raw: unknown): SpeechSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: SpeechSettings = { ...DEFAULT_SPEECH_SETTINGS };

  if (typeof src.voiceName === 'string') {
    const v = src.voiceName.trim();
    if (v.length <= VOICE_NAME_MAX) out.voiceName = v;
  }

  const r = src.rate;
  if (typeof r === 'number' && Number.isFinite(r)) {
    out.rate = roundRate(Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, r)));
  }

  return out;
}

/** 一行摘要（设置卡的状态行）：音色 + 语速 */
export function speechSummary(s: SpeechSettings): string {
  return `${s.voiceName || '系统默认英文音色'} · ${s.rate.toFixed(1)}×`;
}
