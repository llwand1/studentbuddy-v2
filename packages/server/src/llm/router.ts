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
}

export function getProviders(): Provider[] {
  const rows = getDb()
    .prepare('SELECT id, name, base_url, api_key, type, enabled FROM providers ORDER BY created_at')
    .all() as Array<{ id: string; name: string; base_url: string; api_key: string; type: string; enabled: number }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    enabled: r.enabled === 1,
  }));
}

function providerById(id: string) {
  return getDb()
    .prepare('SELECT id, name, base_url, api_key, type, enabled FROM providers WHERE id = ?')
    .get(id) as { id: string; name: string; base_url: string; api_key: string; type: string; enabled: number } | undefined;
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
