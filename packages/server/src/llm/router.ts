/**
 * llm/router — model-router 多角色路由（演进①）。
 * 五角色（讲解/出题/题解/分析/总结）各自绑定 provider+model，未配置落默认 provider。
 * 扩展语义：换出题模型=改一条绑定，不动代码。
 */
import type { ModelRole, Provider } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { decryptSecret } from '../storage/crypto.js';
import type { LLMAdapter } from './types.js';
import { OpenAICompatibleAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';

export const MODEL_ROLES: Array<{ role: ModelRole; label: string }> = [
  { role: 'explain', label: '讲解（日常对话）' },
  { role: 'quiz-generator', label: '出题' },
  { role: 'solver', label: '题解' },
  { role: 'analyzer', label: '薄弱点分析' },
  { role: 'summarizer', label: '总结' },
  // P0-7 新增：PK 裁判（出理解题/判贴合度/给建议）。数组驱动 ⇒ 默认绑定 INSERT 与设置页渲染都自动带上，无需迁移
  { role: 'judge', label: '裁判（PK 判题）' },
];

const adapters: Record<'openai' | 'anthropic', LLMAdapter> = {
  openai: new OpenAICompatibleAdapter(),
  anthropic: new AnthropicAdapter(),
};

export interface RoutedTarget {
  adapter: LLMAdapter;
  model: string;
  apiKey: string;
  baseUrl: string;
  /** 回答呈现形态（v13）：stream=逐字流式（原生 AI 全过程）；once=一次性回答（池中 AI） */
  streamMode: 'stream' | 'once';
}

/** stream_mode 缺省按 type 定位：anthropic 原生协议=流式；openai 兼容（中转池）=一次性 */
function normalizeStreamMode(raw: string | null | undefined, type: string): 'stream' | 'once' {
  if (raw === 'stream' || raw === 'once') return raw;
  return type === 'anthropic' ? 'stream' : 'once';
}

export function getProviders(): Provider[] {
  const rows = getDb()
    .prepare('SELECT id, name, base_url, api_key, type, enabled, stream_mode FROM providers ORDER BY created_at')
    .all() as Array<{
    id: string;
    name: string;
    base_url: string;
    api_key: string;
    type: string;
    enabled: number;
    stream_mode: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    enabled: r.enabled === 1,
    streamMode: normalizeStreamMode(r.stream_mode, r.type),
  }));
}

function providerById(id: string) {
  return getDb()
    .prepare('SELECT id, name, base_url, api_key, type, enabled, stream_mode FROM providers WHERE id = ?')
    .get(id) as
    | { id: string; name: string; base_url: string; api_key: string; type: string; enabled: number; stream_mode: string | null }
    | undefined;
}

/** 默认目标：第一个 enabled 的 provider（兼容未配置角色绑定的开箱路径）。 */
function defaultTarget(): RoutedTarget | null {
  const rows = getDb()
    .prepare('SELECT id FROM providers WHERE enabled = 1 ORDER BY created_at LIMIT 1')
    .all() as Array<{ id: string }>;
  const first = rows[0];
  if (!first) return null;
  return targetFromProvider(first.id);
}

function targetFromProvider(providerId: string): RoutedTarget | null {
  const p = providerById(providerId);
  if (!p || p.enabled !== 1) return null;
  const type = p.type === 'anthropic' ? 'anthropic' : 'openai';
  return {
    adapter: adapters[type],
    model: '', // model 由角色绑定或 provider 默认给出
    apiKey: decryptSecret(p.api_key),
    baseUrl: p.base_url,
    streamMode: normalizeStreamMode(p.stream_mode, p.type),
  };
}

export function routeRole(role: ModelRole, fallbackModel?: string): RoutedTarget & { model: string } | null {
  const binding = getDb()
    .prepare('SELECT provider_id, model FROM role_bindings WHERE role = ?')
    .get(role) as { provider_id: string; model: string } | undefined;

  if (binding) {
    const t = targetFromProvider(binding.provider_id);
    if (t) return { ...t, model: binding.model };
  }
  const def = defaultTarget();
  if (!def) return null;
  // 默认路径：绑定表存每角色默认 model（M1 由设置页写入），缺省用调用方给的模型名
  const defBinding = getDb()
    .prepare('SELECT model FROM role_bindings WHERE role = ?')
    .get(role) as { model: string } | undefined;
  return { ...def, model: defBinding?.model || fallbackModel || '' };
}

/**
 * 角色目标可用性：供各域在失败时区分「**没配**」与「跑挂了」，好让报错说真话（ADR-5）。
 * 2026-09-13 新增——出题曾把「模型没配」与「输出没解析出来」混成一句「模型不可用，可重试」，
 * 用户照着不停重试，永远调不到点子上。
 */
export function roleReady(role: ModelRole): { ok: boolean; reason: string } {
  const t = routeRole(role);
  if (!t) return { ok: false, reason: '没有启用的服务商' };
  if (!t.model) return { ok: false, reason: '该角色还没绑定模型' };
  return { ok: true, reason: '' };
}

/** 空库种子：无 provider 时注入 openai-default（apiKey 留空待用户填，开箱不 500）。 */
export function seedIfEmpty(): void {
  const count = (getDb().prepare('SELECT COUNT(*) AS c FROM providers').get() as { c: number }).c;
  if (count > 0) return;
  const seed = getDb().transaction(() => {
    getDb()
      .prepare(`INSERT INTO providers (id, name, base_url, api_key, type, enabled) VALUES ('openai-default', '默认服务商', 'https://api.openai.com/v1', '', 'openai', 1)`)
      .run();
    for (const { role } of MODEL_ROLES) {
      getDb()
        .prepare(`INSERT OR REPLACE INTO role_bindings (role, provider_id, model) VALUES (?, 'openai-default', '')`)
        .run(role);
    }
  });
  seed();
}
