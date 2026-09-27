/**
 * llm/image-error — 生图上游报文翻译器（纯函数，零依赖零网络零 DB）。
 *
 * 存在理由与 `chat/vision-error.ts`（v0.2.91）一字不差：上游英文 JSON 原样砸给用户，
 * 等于把「能据此动手的信息」埋进「看不懂的报错」——这条规矩来自一次真机故障。
 * 生图（IMAGE-GEN-SPEC §6）在 llm 层再立一份而非复用 chat 层那份：llm 是底层，
 * 反向 import chat/ 会成环（chat/flow → llm/router）；翻译规则两份各自独立演进，
 * 与 `fetch_image.publicReason` 的双份先例同口径（为一个 5 行函数去动刚验证过的代码不划算）。
 *
 * ★ 八分支按「**最具体的排前面**」定序（vision-error 同款）：内容拒绝 ＞ 模型不像生图模型 ＞
 *   401/403 ＞ 429 ＞ 404 ＞ 5xx ＞ 超时由上游信号层处理不在此 ＞ 兜底不猜病因。
 * ★ 每条末行必附 `上游原文：`（压平空白、截 240 字）——**翻译不是掩埋**，排查仍要有现场。
 * ★ 反向锁（测试钉住）：遮掉「内容拒绝」特征后，**不得**再判成内容拒绝——
 *   否则该分支会因正则里别的东西常绿，而它声称在判的那件事没人验过（vision-error 同款教训）。
 */

/** 上游原文展示口径：压平所有空白（JSON 里的换行/缩进对用户是噪声）＋截断（报错不是日志）。 */
export function flattenUpstreamBody(body: string, max = 240): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 内容策略拒绝的特征词（覆盖 OpenAI 兼容生态的常见措辞，中转站多原样透传上游报文）。 */
const CONTENT_POLICY_SIGNS = ['content_policy', 'content policy', 'content_filter', 'safety system', 'flagged', 'moderation'];

/** 「这不是一个生图模型」的特征：model 相关的 404/invalid（绑定错行时最常见）。 */
const MODEL_SIGNS = ['model', '模型'];

/**
 * 把上游失败翻译成「用户能懂、能据此动手」的中文。
 * @param status  上游 HTTP 状态码（0 ＝ 没拿到响应：网络断/连接失败）
 * @param body    上游响应体（原文即可，函数自己压平截断）
 * @param model   本次请求的模型名（报错里点名它，用户才知道去设置页改哪一行）
 */
export function explainImageGenerationFailure(status: number, body: string, model: string): string {
  const flat = flattenUpstreamBody(body);
  // ① 内容策略拒绝：最具体（说的是「这段 prompt」而不是「这个服务」），必须排在状态码之前——
  //    有些中转站把内容拒绝包成 400 甚至 200+错误体，按状态码先判会把它说成「参数错误」。
  const lower = flat.toLowerCase();
  if (CONTENT_POLICY_SIGNS.some((s) => lower.includes(s))) {
    return (
      '上游拒绝了这个生图请求（内容安全策略），这幅内容画不了。换个说法或换个主题再试；' +
      `不是通道坏了，也不必改配置。上游原文：${flat}`
    );
  }
  // ② 模型名不像生图模型：绑定错行（把文本模型绑到了生图角色）时，上游的答复都围着 model 转。
  if (MODEL_SIGNS.some((s) => lower.includes(s)) && (status === 404 || status === 400)) {
    return (
      `模型「${model}」可能不是生图模型（上游不认识它或不接受它出生图请求）。` +
      '请到「设置」→「角色模型绑定」把「生图（画图）」换绑到生图模型。上游原文：' + flat
    );
  }
  // ③ 密钥问题：失效与无权限/欠费分开报——症状都像「模型不可用」，但下一步完全不同
  //    （换 key vs 充值/换服务商），合并成一句会把人引向错误的排查方向（vision-error 同款）。
  if (status === 401) {
    return `生图通道的密钥无效或已过期，请到「设置」→「服务商」更新密钥。上游原文：${flat}`;
  }
  if (status === 403) {
    return `生图通道没有权限（密钥可能欠费或未开通生图模型）。上游原文：${flat}`;
  }
  // ④ 限流：给「可执行下一步」（等一等再发），不是「改设置」。
  if (status === 429) {
    return `生图请求太密被限流了，稍等十几秒再试一次即可。上游原文：${flat}`;
  }
  // ⑤ 端点不存在：多见于 provider 配错了 base_url（少了 /v1 或指到了纯聊天网关）。
  if (status === 404) {
    return (
      '这个服务商地址上没有生图接口（/images/generations 不存在）。' +
      '请检查服务商的接口地址是否完整（通常以 /v1 结尾）。上游原文：' + flat
    );
  }
  // ⑥ 上游故障：如实说「是他们的问题、稍后再试」，不让用户怀疑自己配错。
  if (status >= 500) {
    return `生图服务商暂时故障（HTTP ${status}），稍后再试。上游原文：${flat}`;
  }
  // ⑦ 兜底**不猜病因**：说「看了什么、它是什么」，不编一个具体原因。
  return `生图请求没有成功（HTTP ${status}）。上游原文：${flat}`;
}
