/**
 * search/combine — 取消信号与单请求超时的合并（联网工具共用的一件小事）。
 *
 * 从 `search/index.ts` 拆出（400 行红线），逻辑零改动。拆出去而不是留两份：
 * `chat/tools/fetch-page.ts`、`fetch-image.ts` 与各 provider 实现都要同一份降级口径
 * （仓内「唯一事实源」纪律，同 `htmlToText` 的立项理由）。
 */

/**
 * 外部取消信号与单请求超时合并：用户「停止生成」要能真正掐断搜索的 HTTP 请求，
 * 而不只是让结果被上层丢弃（v13 体验升级：signal 透传进工具内部）。
 * AbortSignal.any 不可用时退化为仅超时（老 Node 仍然能跑，只是少了取消）。
 */
export function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any !== 'function') return timeout;
  return AbortSignal.any([signal, timeout]);
}
