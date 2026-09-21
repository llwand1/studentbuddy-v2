/**
 * SettingsView — 服务商 CRUD + 角色模型绑定（演进①的配置面）+ 联网搜索 key 配置。
 * v13（对话体验升级）：每个服务商可切「回答形态」（流式逐字 / 一次性回答——池中 AI 形态），
 * 并可拉取该服务商的真实模型列表（此前 listModels 是无路由暴露的半成品），拉到的模型
 * 填进角色绑定的输入框 datalist 供挑选，手填仍然可用。
 * ★ 2026-09-21（老板要「配置改得更方便」）：datalist 换成**真下拉**（见 `RoleRow`），
 *   且**开屏就自动拉好候选模型**——不预拉的话，模型那一列在用户手点「拉模型」之前
 *   仍是输入框，"直接用选项选"等于没落地。另加「免费通道 · 一键默认设置」卡。
 */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type { ModelRole } from '@sb/shared';
import './settings.css';
import { SearchKeysCard } from './SearchKeysCard';
import { QuizMixCard } from './QuizMixCard';
import { QuizImageCard } from './QuizImageCard';
import { AnswerStyleCard } from './AnswerStyleCard';
import { ToolsCard } from './ToolsCard';
import { SpeechCard } from './SpeechCard';
import { PlatformChannelCard } from './PlatformChannelCard';
import { RoleRow } from './RoleRow';
import type { ProviderRow } from './RoleRow';

type RoleBindingRow = { role: string; provider_id: string; model: string };

export function SettingsView() {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [roles, setRoles] = useState<Array<{ role: ModelRole; label: string }>>([]);
  const [bindings, setBindings] = useState<RoleBindingRow[]>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  /** 各服务商已拉到的模型列表（下拉候选；拉不到为空数组，此时那一列退化成手填） */
  const [modelsMap, setModelsMap] = useState<Record<string, string[]>>({});
  /**
   * 已经问过上游的服务商 id（**含问过但没拉到**的，那时记空数组）。
   * ★ 用 ref 而不是从 `modelsMap` 推断：`ensureModels` 会被多次调用，
   *   读 state 拿到的是**闭包里的旧值**，会重复打上游（同一个 baseUrl 被连问三次）。
   */
  const asked = useRef<Set<string>>(new Set());

  // 新增表单
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [ptype, setPtype] = useState('openai');

  /** 拉取"还没问过"的服务商候选模型。失败记空数组＝"问过了，没有"，不反复重试。 */
  const ensureModels = (ps: ProviderRow[]) => {
    const missing = ps.filter((p) => !asked.current.has(p.id));
    if (missing.length === 0) return;
    for (const p of missing) asked.current.add(p.id);
    for (const p of missing) {
      void api.providers
        .models(p.id)
        .then((r) => setModelsMap((m) => ({ ...m, [p.id]: r.models })))
        .catch(() => setModelsMap((m) => ({ ...m, [p.id]: [] })));
    }
  };

  const reload = async () => {
    try {
      const [ps, rs] = await Promise.all([api.providers.list(), api.providers.roles()]);
      setProviders(ps);
      setRoles(rs.roles);
      setBindings(rs.bindings);
      ensureModels(ps); // ★ 开屏/增删服务商后立刻把下拉候选备好
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
    // ★ 不再拦空模型：留空 = 「用该服务商的默认模型」（平台通道 ⇒ env/常量；
    //   BYOK ⇒ 该角色会明确报「还没绑定模型」）。拦掉的话，用户就没法把某个角色
    //   从"我选的模型"改回"用默认"——而界面明明给了这个选项。
    try {
      await api.providers.bindRole(role, providerId, model.trim());
      flash(true, model.trim() ? '绑定已保存' : '已设为「用默认模型」');
      await reload();
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    }
  };

  const setStreamMode = async (id: string, streamMode: string) => {
    try {
      await api.providers.update(id, { streamMode });
      flash(true, streamMode === 'once' ? '已切换：一次性回答（思考中 → 整块上屏）' : '已切换：流式逐字输出');
      await reload();
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    }
  };

  const fetchModels = async (id: string) => {
    asked.current.add(id); // 手点也算"问过了"，别让开屏预拉再补一次
    try {
      const r = await api.providers.models(id);
      setModelsMap((m) => ({ ...m, [id]: r.models }));
      flash(r.models.length > 0, r.models.length > 0 ? `拉到 ${r.models.length} 个模型，绑定模型时可选` : '没拉到模型列表（检查 baseUrl/key），仍可手填');
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
              <th>回答形态</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => {
              // 平台 provider：可见、可拉模型、可被绑定，但不可改不可删（服务端同判据，见 routes.ts）
              const isPlatform = p.ownerId === null;
              return (
                <tr key={p.id}>
                  <td>
                    {p.name}
                    {isPlatform && <span className="settings-tag">平台</span>}
                  </td>
                  <td className="mono">{p.baseUrl}</td>
                  <td>
                    <select
                      value={p.streamMode ?? 'stream'}
                      disabled={isPlatform}
                      onChange={(e) => void setStreamMode(p.id, e.target.value)}
                    >
                      <option value="stream">流式逐字</option>
                      <option value="once">一次性回答</option>
                    </select>
                  </td>
                  <td>{p.enabled ? '启用' : '停用'}</td>
                  <td>
                    {/* 开屏已自动拉过；这颗按钮现在是「重拉」（key 刚填、或上游临时不通时用） */}
                    <button className="settings-add" onClick={() => void fetchModels(p.id)}>
                      刷新模型
                    </button>
                    <button className="settings-del" disabled={isPlatform} onClick={() => void removeProvider(p.id)}>
                      删除
                    </button>
                  </td>
                </tr>
              );
            })}
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
                  modelsMap={modelsMap}
                  initialProvider={b?.provider_id ?? ''}
                  initialModel={b?.model ?? ''}
                  onBind={(pid, model) => void bindRole(r.role, pid, model)}
                  // 行内换服务商时按需补拉（该服务商可能还没被问过）
                  onNeedModels={(pid) => void fetchModels(pid)}
                />
              );
            })}
          </tbody>
        </table>
      </section>
      {/* 一键粗调卡放在「精细绑定表」之后：读序＝先看逐角色的现状，再决定要不要一键拉平。
          放最上面会把"你现在的绑定是什么"挡在首屏之外。 */}
      <PlatformChannelCard flash={flash} onConfigured={() => void reload()} />
      <AnswerStyleCard flash={flash} />
      <QuizMixCard flash={flash} />
      <QuizImageCard flash={flash} />
      <SearchKeysCard flash={flash} />
      <SpeechCard flash={flash} />
      <ToolsCard flash={flash} />
    </div>
  );
}
