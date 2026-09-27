/**
 * llm/image-gen — 生图适配器：`image` 角色 → OpenAI 兼容 `/images/generations` → 站内图片。
 *
 * 契约 `docs/IMAGE-GEN-SPEC.md` §2/§4/§5。定位与 `llm/openai.ts` 平行：那件是**聊天**适配器
 * （打 `/chat/completions`），本件是**生图**适配器（打 `/images/generations`）——两者共用
 * 同一条 provider 双通道（`routeRole` 的三档查序、env 凭据注入、两层并发闸、250 次/5h 次数表），
 * 但**不共用 LLMAdapter 接口**：生图没有流式、没有消息历史，塞进 chat() 签名是假接口。
 *
 * ★ 为什么 `routeRole('image')` 返回的 `adapter` 本件**不用**：那是绑好配额的聊天适配器，
 *   生图只取它的 `{ model, apiKey, baseUrl, quota, type }`——凭据解析与归属判定复用一份实现
 *   （"用哪把 key、打哪个地址"全仓只能有一份，platform-channel.ts 头注），
 *   而出站请求由本件自己拼。
 */
import { combineSignals } from '../search/combine.js';
import { fetchSafe } from '../search/ssrf-guard.js';
import { MAX_IMAGE_BYTES, saveImage, sniffImage, imageUrlOf } from '../storage/image-cache.js';
import { routeRole, roleReady } from './router.js';
import { explainImageGenerationFailure } from './image-error.js';
import { acquireUpstream } from './upstream-gate.js';
import {
  IMAGE_TOOL_NAME,
  countTodayImages,
  imageDailyLimit,
  imageSlotKey,
  releaseImageSlot,
  tryAcquireImageSlot,
} from './image-quota.js';

/** 单张生成总时长上限。**必须短于**工具调度层 network 档的 60s：内部超时要先响，
 *  否则调度层先掐断，回灌文案被 `工具执行失败：…` 这层壳包走，错误翻译器全白做。 */
const IMAGE_TIMEOUT_MS = 50_000;

/** 出图尺寸白名单。白名单外的值（含模型自造的）一律回落 `1024x1024`，不透传上游。 */
export const IMAGE_SIZES = ['1024x1024', '1024x1792', '1792x1024'] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

export function normalizeImageSize(raw: unknown): ImageSize {
  return (IMAGE_SIZES as readonly string[]).includes(String(raw)) ? (String(raw) as ImageSize) : '1024x1024';
}

/** prompt 截断上限：生图提示词长了上游既慢又容易漂，1000 字足够描述一张学习示意图。 */
export const IMAGE_PROMPT_MAX_CHARS = 1000;

export interface GeneratedImage {
  /** 内容 hash 文件名（`<32hex>.<ext>`，`image-cache` 闸门口径） */
  name: string;
  /** 站内相对地址（`/api/images/<name>`，随访问源自适应，直接可写进正文） */
  url: string;
  bytes: number;
  ext: string;
}

export type ImageGenResult =
  | { ok: true; image: GeneratedImage }
  | { ok: false; reason: 'not-bound' | 'provider-type' | 'disabled' | 'quota' | 'busy' | 'gate' | 'upstream'; message: string };

/**
 * 生成一张图（对外唯一入口）。
 *
 * ★ 判定顺序不可换：**没配 → 协议不对 → 张数闸 → 并发坑 → 上游**——每一关都在下一关
 *   之前，是因为越靠前的检查越便宜、且不该让注定失败的请求占住并发坑（同款教训：
 *   超额请求停在闸门外，不牵连他人）。
 * ★ `ownerId` 三态语义：登录用户走「张数闸 ＋ 次数表」；`null`（本地单人模式）
 *   不过张数闸——与 LLM 侧 `meteredOwner` 的既有口径逐字一致（本地单人模式不计费）。
 */
export async function generateImageForOwner(
  ownerId: string | null,
  prompt: string,
  size: unknown,
  signal?: AbortSignal,
): Promise<ImageGenResult> {
  const ready = roleReady('image', ownerId);
  if (!ready.ok) {
    return {
      ok: false,
      reason: 'not-bound',
      message: `${ready.reason}——生图需要在「设置」→「角色模型绑定」给「生图（画图）」绑一个 OpenAI 兼容的生图模型。`,
    };
  }
  const target = routeRole('image', undefined, ownerId);
  if (!target) return { ok: false, reason: 'not-bound', message: '没有可用的服务商' };

  // anthropic 原生协议没有 /images/generations：在这里挡住并说人话，不放出去撞必然 404。
  if (target.type !== 'openai') {
    return {
      ok: false,
      reason: 'provider-type',
      message: '生图只支持 OpenAI 兼容的服务商，当前「生图（画图）」绑定的服务商是 Anthropic 原生协议——请换绑或到设置页调整。',
    };
  }

  // 平台通道张数闸：先查再打（到顶不发起上游请求，不白烧一次调用）。limit 0 ＝ 整体关闭。
  if (target.quota.platform && ownerId !== null) {
    const limit = imageDailyLimit();
    if (limit === 0) {
      return { ok: false, reason: 'disabled', message: '平台通道的生图功能当前已关闭，可以改用自己的服务商（设置 → 服务商）。' };
    }
    const used = countTodayImages(ownerId);
    if (used >= limit) {
      return {
        ok: false,
        reason: 'quota',
        message: `今天平台通道的免费生图张数（每天 ${limit} 张）已经用完了，明天 0 点后再来；或到「设置」绑定自己的服务商继续画。`,
      };
    }
  }

  const slot = imageSlotKey(ownerId);
  if (!tryAcquireImageSlot(slot)) {
    return { ok: false, reason: 'busy', message: '上一张图还在生成中，等它完成再发下一张。' };
  }

  try {
    let release: (() => void) | undefined;
    try {
      release = await acquireUpstream(target.baseUrl, 'main', undefined, target.quota);
    } catch (err) {
      // 并发闸/次数表的报错都是设计好的用户可读文案（UPSTREAM_BUSY_MESSAGE /
      // PlatformQuotaExceededError），原样透传——翻译在这里是掩埋。
      return { ok: false, reason: 'gate', message: err instanceof Error ? err.message : String(err) };
    }
    try {
      return await requestImage(target, prompt, normalizeImageSize(size), signal);
    } finally {
      release();
    }
  } finally {
    releaseImageSlot(slot);
  }
}

/** 发起生图请求并把产物落进 image-cache。签名里 size 已过白名单。 */
async function requestImage(
  target: NonNullable<ReturnType<typeof routeRole>>,
  prompt: string,
  size: ImageSize,
  signal?: AbortSignal,
): Promise<ImageGenResult> {
  const endpoint = `${target.baseUrl.replace(/\/+$/, '')}/images/generations`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}` },
      body: JSON.stringify({ model: target.model, prompt, n: 1, size, response_format: 'b64_json' }),
      signal: combineSignals(signal, IMAGE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: 'upstream', message: `生图请求没有发出去（${err instanceof Error ? err.message : String(err)}）。可稍后重试。` };
  }

  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    return {
      ok: false,
      reason: 'upstream',
      message: explainImageGenerationFailure(res.status, bodyText, target.model),
    };
  }

  // 响应双兼容：b64_json 直解；url 则下载（上游给的地址也是「第三方地址」，SSRF 逐跳复检不豁免）。
  let bytes: Uint8Array;
  try {
    const parsed = JSON.parse(bodyText) as { data?: Array<{ b64_json?: string; url?: string }> };
    const first = parsed.data?.[0];
    if (typeof first?.b64_json === 'string' && first.b64_json.length > 0) {
      bytes = new Uint8Array(Buffer.from(first.b64_json, 'base64'));
    } else if (typeof first?.url === 'string' && first.url.length > 0) {
      const dl = await fetchSafe(first.url, { signal: combineSignals(signal, IMAGE_TIMEOUT_MS) });
      if (!dl.ok) {
        return { ok: false, reason: 'upstream', message: `生成的图片下载失败（HTTP ${dl.status}），可重试一次。` };
      }
      // 体积预闸 ＋ 读后复核：content-length 会缺失或谎报（fetch_image.readCapped 同款教训），
      // 这里量级可控（生图产物 ≤ 数 MB），预闸挡超大、复核挡谎报。
      const declared = Number(dl.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        return { ok: false, reason: 'upstream', message: '生成的图片异常超大，没有接收——请重试。' };
      }
      const buf = new Uint8Array(await dl.arrayBuffer());
      if (buf.byteLength > MAX_IMAGE_BYTES) {
        return { ok: false, reason: 'upstream', message: '生成的图片异常超大，没有接收——请重试。' };
      }
      bytes = buf;
    } else {
      return {
        ok: false,
        reason: 'upstream',
        message: `上游没有返回图片数据（响应里既没有 b64_json 也没有 url）。上游原文：${bodyText.slice(0, 200)}`,
      };
    }
  } catch {
    return { ok: false, reason: 'upstream', message: '上游响应不是合法的生图结果，可重试一次。' };
  }

  // 判在**原始字节**上（不信任 response_format/image_url 的自报类型）。
  const type = sniffImage(bytes);
  if (!type) {
    return { ok: false, reason: 'upstream', message: '上游返回的内容不是可渲染的图片，已丢弃——可重试一次。' };
  }
  const { name } = saveImage(bytes, type.ext);
  return { ok: true, image: { name, url: imageUrlOf(name), bytes: bytes.byteLength, ext: type.ext } };
}

/** 给测试与日志用的短标签（不参与逻辑）。 */
export function imageToolLabel(): string {
  return IMAGE_TOOL_NAME;
}
