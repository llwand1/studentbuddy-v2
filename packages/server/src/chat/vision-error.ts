/**
 * chat/vision-error — 把「看图失败」的上游报文翻成人话（ADR-5：失败必须可读、可重试）。
 *
 * 为什么单独一个文件：`chat/vision.ts` 只管"怎么把图蒸馏成文字"，而**失败长什么样**是
 * 上游服务商的事，两种关注点混在一起会让 vision.ts 变成一堆正则。这里做成纯函数
 * （零依赖、零网络、零 DB），所以它能被单测逐条钉住。
 *
 * ★ 触发本文件的真机事故（2026-09-20）：`vision` 角色被绑成了 `agnes-image-2.5-flash`
 *   —— 那是**生成图片**的模型，不接受 `image_url` 输入。上游回
 *   `400 {"error":{"message":"模型 agnes-image-2.5-flash 是 image 模型，请使用 /v1/images/generations"}}`，
 *   这串英文 JSON 被 `flow.ts` 原样 `chat-error` 推给用户，老板看到的就是"提示 400"。
 *   配置错不可怕，可怕的是**报错不告诉他怎么改**——本文件的存在理由就是把那条 400
 *   变成「去设置页把『视觉（看图）』改绑支持图片输入的对话模型」。
 */

/** 上游原文回显长度：够看清病因，又不至于把错误框撑爆 */
const RAW_SNIPPET_CHARS = 240;

/** 从适配器抛出的 `OpenAI/Anthropic API error <status>: <body>` 里取 HTTP 状态码，取不到返回 0 */
function upstreamStatus(raw: string): number {
  const m = /\bAPI error (\d{3})\b/.exec(raw);
  if (m) return Number(m[1]);
  const s = /\b([45]\d\d)\b/.exec(raw);
  return s ? Number(s[1]) : 0;
}

function snippet(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > RAW_SNIPPET_CHARS ? `${oneLine.slice(0, RAW_SNIPPET_CHARS)}…` : oneLine;
}

/**
 * 视觉调用失败的**用户可读**原因。
 *
 * @param err 适配器抛出的原始错误（`Error` 或任意值）
 * @param model 本轮实际调用的视觉模型名（进文案，便于老板对着设置页核对）
 * @returns 多行中文：第一行是病因+动作指引，其后附上游原文（截断）备查
 *
 * 判据顺序即优先级：**最具体的排前面**（生成模型误绑 / 不支持图片），
 * 因为一条 400 报文里往往同时出现 "image" 与 "model"，先匹配到的赢。
 */
export function explainVisionFailure(err: unknown, model: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const status = upstreamStatus(raw);
  const suffix = `上游原文：${snippet(raw)}`;
  const at = `（视觉模型 \`${model || '未绑定'}\`）`;

  // ① 误绑「生成图片/视频」的模型：这类模型只吃 /v1/images/generations，方向与看图相反
  if (/是\s*image\s*模型|\/images\/generations|text-to-image|generation model|只能生成/i.test(raw)) {
    return (
      `看图失败${at}：这个模型只会**生成图片**，不会**读图片**，不能当视觉模型用。` +
      `请到设置页「角色模型绑定」把「视觉（看图）」改绑一个支持图片输入的对话模型。` +
      `\n${suffix}`
    );
  }
  // ② 模型本身不支持图片输入（纯文本模型被绑给了视觉角色）
  if (/does not support image|unsupported content type|invalid.*image_url|not multimodal|image input/i.test(raw)) {
    return (
      `看图失败${at}：这个模型不接受图片输入。请到设置页把「视觉（看图）」改绑支持图片输入的模型` +
      `（如 qwen-vl-plus / glm-4v / gpt-4o，或任何官方标注"输入含图像"的对话模型）。` +
      `\n${suffix}`
    );
  }
  // ③ 模型名不存在（服务商改名/下线，或绑定里填错了）
  if (status === 404 || /model .*not (found|exist)|invalid model|模型不存在/i.test(raw)) {
    return `看图失败${at}：服务商说没有这个模型，模型名可能已改名或填错。请到设置页重新选择视觉模型。\n${suffix}`;
  }
  // ④ 鉴权：key 失效/欠费/无该模型权限——症状与"模型不可用"极像，必须分开报
  if (status === 401 || status === 403 || /invalid api key|unauthorized|authentication|insufficient (balance|credit)|欠费|余额不足/i.test(raw)) {
    return `看图失败${at}：服务商拒绝了这把密钥（无效／过期／欠费／无该模型权限）。请到设置页检查该服务商的 API Key 与账户余额。\n${suffix}`;
  }
  // ⑤ 限流：免费档最常见，且**重试往往就能过**，所以文案要给"稍后再试"而不是"改设置"
  if (status === 429 || /rate limit|too many requests|quota|并发/i.test(raw)) {
    return `看图失败${at}：服务商限流（免费档的速率/日额度被打满）。稍等十几秒再发一次；频繁出现请给视觉角色换一个额度更宽的服务商。\n${suffix}`;
  }
  // ⑥ 上游自身故障
  if (status >= 500) {
    return `看图失败${at}：服务商那边出错了（HTTP ${status}），不是本地配置问题。稍后重试，持续失败请换视觉模型。\n${suffix}`;
  }
  // ⑦ 超时/中断（upstream-timeout.ts 已把 AbortError 翻过一遍，这里只兜漏网的）
  if (/超时|timed? ?out|abort/i.test(raw)) {
    return `看图失败${at}：视觉模型响应超时（图片越大越慢）。可以稍后重试，或换更快的视觉模型。\n${suffix}`;
  }
  // ⑧ 兜底：认不出来的**不猜**，原样给出但说清是谁在失败
  return `看图失败${at}：${suffix}`;
}
