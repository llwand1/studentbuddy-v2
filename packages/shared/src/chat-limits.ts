/**
 * chat-limits — 图片输入那三笔限额的**单一事实源**（2026-09-20）。
 *
 * 为什么必须收敛到一处：这三笔数字原本分散在三个包里各写一遍——
 * 前端 `ChatComposer.tsx` 的 `MAX_IMAGES`、服务端 `chat/vision.ts` 的
 * `MAX_IMAGES` / `MAX_DATAURL_CHARS`、`index.ts` 的 `express.json({ limit: '24mb' })`，
 * 而三处注释都写着「与另一处是同一套账」。**靠注释维持的账本迟早不平**，实测已经不平：
 * 单张 700 万字符 × 4 张 = 2800 万字符（≈28MB）> 24mb，即
 * **「4 张各自都合法的图一起发会撞 express 413」**——而 413 发生在路由之前，
 * 业务层拿不到，用户看到的是历史上踩过的那个假象：「点发送没反应」。
 *
 * 现改为：数字只在这里出现一次，其余三处一律 import；并给出
 * `worstCaseChatBodyBytes()` 供测试断言「满额图片请求必须装得进 body 限额」——
 * 把「账要平」从注释里的自觉变成机器拦得住（改大单张上限却不动 body ⇒ 测试直接红）。
 */

/** 一次提问最多带几张图（多了上下文爆、视觉调用也贵） */
export const MAX_CHAT_IMAGES = 4;

/**
 * 单张 dataURL 字符上限。
 *
 * 500 万字符 ≈ 3.75MB 原图（base64 相对原字节膨胀 4/3）。
 * 定在 5MB 而不是更大，是为了让「满额 4 张」装得进下面的 body 限额——
 * 上限不是越大越好，**能一起发出去的上限才是有用的上限**。
 */
export const MAX_IMAGE_DATAURL_CHARS = 5_000_000;

/**
 * `/api/chat/send` 的 JSON body 上限（仅这一条路由放大；其余端点仍是 2mb，见 `server/src/index.ts`）。
 * 走 base64 内联是零依赖路线的既定代价：一张截图 base64 就是 2~5MB，沿用 2mb 会让请求
 * 在到达路由之前被 413 打回。
 */
export const CHAT_BODY_LIMIT = '24mb';

/** 上面那笔限额的字节数（express 的 `'24mb'` 按 1024 进制解释，这里与它同口径） */
export const CHAT_BODY_LIMIT_BYTES = 24 * 1024 * 1024;

/**
 * 满额图片请求（`MAX_CHAT_IMAGES` 张、每张顶到 `MAX_IMAGE_DATAURL_CHARS`）的**最坏字节数**估计。
 *
 * 为什么不能只算 dataURL 本体：body 里除图片还有 JSON 包装（字段名、引号、逗号、
 * 文件名）与提问正文——这两块原先没人记账，正是「账看着平、实际不平」的来源。
 * 图片名按 UTF-8 中文计，故单张包装留 64 字节而非 32。
 *
 * 正文按 2 万字符估（正常提问远达不到；超长粘贴由 body 限额自己兜底，与本账无关）。
 */
export function worstCaseChatBodyBytes(): number {
  const jsonOverheadPerImage = 64;
  const textBudgetChars = 20_000;
  return MAX_CHAT_IMAGES * (MAX_IMAGE_DATAURL_CHARS + jsonOverheadPerImage) + textBudgetChars;
}

/**
 * 单张图片的**近似原图体积**文案，供 UI 报错用。
 * 给用户看「约 3.6MB」而不是「5000000 字符」——后者是内部记账单位，对用户没有意义。
 */
export function maxImageSizeHint(): string {
  const mb = (MAX_IMAGE_DATAURL_CHARS * 0.75) / (1024 * 1024);
  return `约 ${mb.toFixed(1)}MB`;
}
