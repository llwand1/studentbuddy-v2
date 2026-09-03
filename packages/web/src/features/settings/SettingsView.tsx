/**
 * SettingsView — 服务商 CRUD + 角色模型绑定（演进①的配置面）+ 联网搜索 key 配置。
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type { ModelRole } from '@sb/shared';
import './settings.css';
import { SearchKeysCard } from './SearchKeysCard';
import { QuizMixCard } from './QuizMixCard';

type ProviderRow = { id: string; name: string; baseUrl: string; enabled: boolean };
type RoleBindingRow = { role: string; provider_id: string; model: string };

export function SettingsView() {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [roles, setRoles] = useState<Array<{ role: ModelRole; label: string }>>([]);
  const [bindings, setBindings] = useState<RoleBindingRow[]>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // 新增表单
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [ptype, setPtype] = useState('openai');

  const reload = async () => {
    try {
      const [ps, rs] = await Promise.all([api.providers.list(), api.providers.roles()]);
      setProviders(ps);
      setRoles(rs.roles);
      setBindings(rs.bindings);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const flash = (ok: boolean, text: string) => {
    if (ok) {
      setMsg(text);
      setErr('');
    } else {
      setErr(text);
      setMsg('');
    }
    setTimeout(() => {
      setMsg('');
      setErr('');
    }, 2600);
  };

  const addProvider = async () => {
    if (!name.trim() || !baseUrl.trim()) {
      flash(false, '名称与 baseUrl 必填');
      return;
    }
    try {
      await api.providers.create({ name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), type: ptype });
      setName('');
      setBaseUrl('');
      setApiKey('');
      flash(true, '已添加');
      await reload();
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    }
  };

  const bindRole = async (role: string, providerId: string, model: string) => {
    if (!model.trim()) {
      flash(false, '模型名必填');
      return;
    }
    try {
      await api.providers.bindRole(role, providerId, model.trim());
      flash(true, '绑定已保存');
      await reload();
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    }
  };

  const removeProvider = async (id: string) => {
    try {
      await api.providers.remove(id);
      flash(true, '已删除');
      await reload();
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    }
  };


  return (
    <div className="settings-view">
      <h2>设置</h2>
      {msg && <div className="settings-msg ok">{msg}</div>}
      {err && <div className="settings-msg err">{err}</div>}

      <section className="settings-sec">
        <h3>服务商</h3>
        <table className="settings-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>baseUrl</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="mono">{p.baseUrl}</td>
                <td>{p.enabled ? '启用' : '停用'}</td>
                <td>
                  <button className="settings-del" onClick={() => void removeProvider(p.id)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="settings-form">
          <input placeholder="名称（如 agnes）" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="baseUrl（如 https://xx/v1）" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <input placeholder="apiKey（密文存储）" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <select value={ptype} onChange={(e) => setPtype(e.target.value)}>
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
          </select>
          <button className="settings-add" onClick={() => void addProvider()}>
            添加
          </button>
        </div>
      </section>

      <section className="settings-sec">
        <h3>角色模型绑定</h3>
        <p className="settings-hint">每个学习环节可独立选模型（未绑定的环节走默认服务商）；出题建议强模型、总结可用便宜模型。</p>
        <table className="settings-table">
          <thead>
            <tr>
              <th>角色</th>
              <th>服务商</th>
              <th>模型</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => {
              const b = bindings.find((x) => x.role === r.role);
              return (
                <RoleRow
                  key={r.role}
                  label={r.label}
                  providers={providers}
                  initialProvider={b?.provider_id ?? ''}
                  initialModel={b?.model ?? ''}
                  onBind={(pid, model) => void bindRole(r.role, pid, model)}
                />
              );
            })}
          </tbody>
        </table>
      </section>

      <QuizMixCard flash={flash} />
      <SearchKeysCard flash={flash} />
    </div>
  );
}

function RoleRow({
  label,
  providers,
  initialProvider,
  initialModel,
  onBind,
}: {
  label: string;
  providers: ProviderRow[];
  initialProvider: string;
  initialModel: string;
  onBind: (providerId: string, model: string) => void;
}) {
  const [pid, setPid] = useState(initialProvider || providers[0]?.id || '');
  const [model, setModel] = useState(initialModel);
  return (
    <tr>
      <td>{label}</td>
      <td>
        <select value={pid} onChange={(e) => setPid(e.target.value)}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input placeholder="模型名（如 agnes-2.5-flash）" value={model} onChange={(e) => setModel(e.target.value)} />
      </td>
      <td>
        <button
          className="settings-add"
          onClick={() => onBind(pid, model)}
          disabled={!pid}
        >
          保存
        </button>
      </td>
    </tr>
  );
}
