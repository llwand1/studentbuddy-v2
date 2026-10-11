/** 外部 agent 仅可追加词条；归属与复习状态不由条目自行指定。 */
export interface AgentKeyView {
  id: string; name: string; prefix: string; createdAt: number; expiresAt: number;
  lastUsedAt: number | null; revokedAt: number | null;
  permissions?: string[];
}
export interface AgentTermInput {
  term: string; definition: string; domain: string; importance: number; aliases: string[];
  sourceUrls: string[]; sourceNote: string;
}
export interface AgentTermBatch { batchId: string; review: boolean; terms: AgentTermInput[] }
export interface AgentTermResult {
  index: number; id: string; term: string; status: 'added' | 'skipped';
  visibleInCurrentScope: boolean; warnings: string[]; sourceNote: string;
}
export interface AgentImportReceipt { batchId: string; added: number; skipped: number; replayed: boolean; results: AgentTermResult[] }
export const AGENT_TERM_BATCH_LIMIT = 100;
export const AGENT_KEY_MAX_DAYS = 90;
type Validation = { ok: true; value: AgentTermBatch } | { ok: false; error: string; index?: number };
const object = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const string = (x: unknown, max: number) => typeof x === 'string' && x.trim().length > 0 && x.trim().length <= max;
const fields = new Set(['term', 'definition', 'domain', 'importance', 'aliases', 'sourceUrls', 'sourceNote', 'source_host', 'freq']);

export function validateAgentTermBatch(input: unknown): Validation {
  if (!object(input) || Object.keys(input).some(k => !['batchId', 'review', 'terms'].includes(k))) return { ok: false, error: '只接受 batchId、review、terms；归属由密钥决定。' };
  if (!string(input.batchId, 100) || !/^[A-Za-z0-9._:-]+$/.test(String(input.batchId))) return { ok: false, error: 'batchId 必须为 1–100 个字母数字或 . _ : -。' };
  if (input.review !== undefined && typeof input.review !== 'boolean') return { ok: false, error: 'review 必须为布尔值。' };
  if (!Array.isArray(input.terms) || input.terms.length < 1 || input.terms.length > AGENT_TERM_BATCH_LIMIT) return { ok: false, error: '每批需要 1–100 条词条。' };
  const terms: AgentTermInput[] = [];
  for (const [index, raw] of input.terms.entries()) {
    const fail = (error: string): Validation => ({ ok: false, index, error });
    if (!object(raw) || Object.keys(raw).some(k => !fields.has(k))) return fail('词条字段不合法，不能指定归属、会话或复习状态。');
    if (!string(raw.term, 100) || !string(raw.definition, 4000)) return fail('term 需要 1–100 字，definition 需要 1–4000 字。');
    if (raw.domain !== undefined && !string(raw.domain, 30)) return fail('domain 需要 1–30 字。');
    if (raw.importance !== undefined && (typeof raw.importance !== 'number' || !Number.isFinite(raw.importance) || raw.importance < 0 || raw.importance > 1)) return fail('importance 需要为 0–1 的数字。');
    const aliases = raw.aliases === undefined ? [] : raw.aliases;
    if (!Array.isArray(aliases) || aliases.length > 8 || aliases.some(a => !string(a, 100))) return fail('aliases 最多 8 个，每个 1–100 字。');
    const sourceUrls = raw.sourceUrls === undefined ? [] : raw.sourceUrls;
    if (!Array.isArray(sourceUrls) || sourceUrls.length > 3) return fail('sourceUrls 最多 3 个 http(s) URL。');
    const urls: string[] = [];
    for (const source of sourceUrls) {
      if (!string(source, 2000)) return fail('来源 URL 需要 1–2000 字。');
      try {
        const url = new URL(String(source));
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2000) return fail('来源只接受不含账号密码的 http(s) URL。');
        urls.push(url.href);
      } catch { return fail('来源 URL 不合法。'); }
    }
    if (raw.sourceNote !== undefined && typeof raw.sourceNote !== 'string') return fail('sourceNote 必须为文字。');
    if (raw.source_host !== undefined && typeof raw.source_host !== 'string') return fail('source_host 必须为文字，不代替完整 URL。');
    if (raw.freq !== undefined && (typeof raw.freq !== 'number' || !Number.isFinite(raw.freq) || raw.freq < 0)) return fail('freq 必须为非负数字。');
    const sourceNote = [raw.sourceNote, raw.source_host].filter((s): s is string => typeof s === 'string' && Boolean(s.trim())).map(s => s.trim()).join('；');
    if (sourceNote.length > 300) return fail('来源注记合计最多 300 字。');
    terms.push({ term: String(raw.term).trim(), definition: String(raw.definition).trim(),
      domain: typeof raw.domain === 'string' ? raw.domain.trim().toLowerCase() : 'general',
      importance: typeof raw.importance === 'number' ? raw.importance : 0.5,
      aliases: [...new Set((aliases as string[]).map(a => a.trim()))], sourceUrls: [...new Set(urls)], sourceNote });
  }
  return { ok: true, value: { batchId: String(input.batchId), review: input.review !== false, terms } };
}

/** 指令不含密钥，agent 从私有环境变量读取；可直接复制给不同 coding agent。 */
export function agentTermsInstructions(origin: string): string {
  return `请为我的 StudentBuddy 搜索、筛选并整理有明确释义的学习词条。\n接口根地址：${origin}/api/open/v1\n密钥从环境变量 STUDENTBUDDY_TERMS_TOKEN 读取，使用 Authorization: Bearer；不要输出密钥。\n先 GET /context 读取应试范围，再 GET /terms?limit=200&offset=0 分页检查已有词条。联网来源保留真实完整 URL，不能编造引用；无网页来源的概念如实写 sourceNote。\nPOST /terms/import，JSON 示例：{"batchId":"唯一且重试时不变的批次ID","review":true,"terms":[{"term":"词名","definition":"准确完整的释义","domain":"领域","sourceUrls":["真实来源URL"]}]}。每批最多100条。已有词条不会覆盖。按回执报告 added、skipped 和 warnings；visibleInCurrentScope=false 表示已保存但当前应试范围不显示。\n完整规范：${origin}/api/open/v1/openapi.json`;
}
