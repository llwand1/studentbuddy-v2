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

// ── P3 确认门实施口径（2026-09-19 登记，契约 TOOL-ECOSYSTEM-SPEC §4.2/§4.6/§6.3-4）──────

/** `by_size` 缺省阈值（v1.4 拍板⑮：立约时 3 改定为 5；设置页可调，0＝从不等） */
export const DEFAULT_CONFIRM_THRESHOLD = 5;

/** 无回执多久按拒绝收口（保守，§6.3-4：等不到答案就当不同意） */
export const CONFIRM_TIMEOUT_MS = 60_000;

/** 阈值的设置存储键（`app_settings`，v30 起每用户一份；读不到/坏值回退默认 5） */
export const SETTING_KEY_CONFIRM_THRESHOLD = 'confirm_threshold';

/** 设置页三档（§6.3-4 拍板⑮）：1=每次都问、5=默认、0=从不等；0 档 UI 必须写明风险 */
export const CONFIRM_THRESHOLD_CHOICES = [1, 5, 0] as const;

/**
 * 阈值归一化（落库前与读取后都过一道，口径同 `normalizeAnswerStyle`）：
 * 非有限数/负数/超 50（阈值高于 `delete_terms` 单次上限，给了也是没给）一律回退默认；
 * 小数向下取整（0.5 条这种"半个改动"不存在，猜半档不如回默认）。
 */
export function normalizeConfirmThreshold(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 50) return DEFAULT_CONFIRM_THRESHOLD;
  return Math.floor(n);
}

/**
 * 用户对确认卡的裁决。`allow_session` 只对**同一工具 + 同一确认档**生效（§6.3-4），
 * 且批准态只存内存不落库——应用重启回到最严档（这是 §11 澄清「确认门≠审批引擎」的一部分）。
 */
export type ToolConfirmDecision = 'allow_once' | 'allow_session' | 'deny' | 'timeout';

/** 确认请求的线上形状（帧字段逐条对齐契约 §6.4；items ≤8 行×≤40 字由 server 出 PendingWrite 时裁好） */
export interface ToolConfirmRequest {
  requestId: string;
  tool: string;
  source: 'builtin' | 'mcp';
  /** 仅 MCP 工具带：所属 server 名（「谁在动手」要看得见，§6.3-4） */
  server?: string;
  /** 动作一句话（§5.1 确认卡硬要求①，v1.4 实施细化：只有条数没有清单的卡不许上线） */
  actionSummary: string;
  affected: number;
  items: string[];
  /** 绝对过期时刻（ms）＝发出 + CONFIRM_TIMEOUT_MS，前端倒计时用；到期裁决由服务端定时器代答 timeout */
  expiresAt: number;
}

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
