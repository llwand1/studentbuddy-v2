/**
 * tool-ecosystem —— 工具生态的跨端契约类型（契约 `docs/TOOL-ECOSYSTEM-SPEC.md` §4.2）。
 *
 * ★ 为什么放 shared 而不是 server 本地：`kind` 决定三件事——超时档位、是否进确认门（P3）、
 *   前端过程卡的图标语义。三处消费分居 server 与 web，各写一份联合类型必漂（同 `sse-events.ts` 的立项理由）。
 */

/** 工具类别：决定默认超时档位与确认策略缺省（P3 接 `needsConfirm`）。external = MCP/第三方 */
export type ToolKind = 'read' | 'write' | 'network' | 'external';

/**
 * v1.3 拍板⑪：超时按 kind 分档，**否决全局调大**（全局 60/90s 时最坏等待＝15 轮 × 多工具 × 新超时）。
 * 真正需要更长的只有「内部再调 LLM」的工具（`tidy_terms auto`、未来 `generate_quiz`），
 * 那是**逐工具显式 `timeoutMs`** 的活（见注册表字段），不拉高档位基线。
 */
export const KIND_TIMEOUT_MS: Record<ToolKind, number> = {
  read: 30_000,
  write: 30_000,
  network: 60_000,
  external: 60_000,
};

/** 内部再调 LLM 的工具的显式超时（注册时逐工具写在 `timeoutMs` 上，不是档位） */
export const TOOL_LLM_INNER_TIMEOUT_MS = 120_000;

/**
 * v1.2：确认策略三态（P2 先落类型，**P3 才生效**——届时缺省 read/network=false、
 * write='by_size'、external=true，见契约 §4.6）。
 */
export type ConfirmPolicy = false | true | 'by_size';

/** 下发裁剪上限（§4.4）：超出按「内建优先 + 声明顺序」截断并如实显示，ADR-5 不静默 */
export const MAX_DISPATCHED_TOOLS = 16;

/** 归一化参数用于同轮去重键（§4.3-4）：key 序稳定化，`{"a":1,"b":2}` 与 `{"b":2,"a":1}` 是同一个调用 */
export function canonicalToolArgs(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson || '{}') as unknown;
    return stableStringify(parsed) ?? String(argsJson);
  } catch {
    // 解析失败的串原样作键——runTool 会在执行前就拒掉它，键只需区分「不同的坏串」
    return argsJson;
  }
}

function stableStringify(v: unknown): string | null {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => stableStringify(x));
    if (parts.some((p) => p === null)) return null;
    return `[${parts.join(',')}]`;
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}
