import { useEffect, useState } from 'react';
import { agentTermsInstructions, type AgentKeyView } from '@sb/shared';
import { agentKeysApi } from '../../lib/api-agent-terms';
import './agent-terms.css';

export function AgentTermsCard({ flash }: { flash: (ok: boolean, text: string) => void }) {
  const [keys, setKeys] = useState<AgentKeyView[]>([]);
  const [name, setName] = useState('我的 coding agent');
  const [days, setDays] = useState(30);
  const [fresh, setFresh] = useState<{ id: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const instructions = agentTermsInstructions(window.location.origin);
  useEffect(() => {
    let alive = true;
    void agentKeysApi.list().then(r => { if (alive) setKeys(r.keys); }).catch(e => { if (alive) setError(e instanceof Error ? e.message : '读取密钥失败'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); flash(true, '已复制'); }
    catch { setError('浏览器未允许复制，请手动选择内容复制。'); }
  };
  const create = async () => {
    setBusy(true); setError('');
    try {
      const r = await agentKeysApi.create(name, days);
      setFresh({ id: r.key.id, token: r.token });
      setKeys((all) => [r.key, ...all]);
      flash(true, '密钥已生成，可以交给外部 agent 存词');
    } catch (e) { setError(e instanceof Error ? e.message : '创建密钥失败'); }
    finally { setBusy(false); }
  };
  const revoke = async (key: AgentKeyView) => {
    setBusy(true); setError('');
    try {
      await agentKeysApi.revoke(key.id);
      setKeys(all => all.map(k => k.id === key.id ? { ...k, revokedAt: Date.now() } : k));
      if (fresh?.id === key.id) setFresh(null);
      flash(true, '密钥已撤销，外部 agent 不能再调用');
    } catch (e) { setError(e instanceof Error ? e.message : '撤销失败'); }
    finally { setBusy(false); }
  };
  return <section className="settings-sec agent-terms-card" aria-label="外部 agent 存词">
    <h3>外部 agent · 词条补给</h3>
    <p className="settings-hint">让 coding agent 用自己的搜索能力整理词条，批量送进你的词库。专用密钥允许读取词库和新增词条，重复词会跳过，保留原有释义与复习进度。</p>
    <div className="agent-terms-form">
      <label>密钥名称<input value={name} maxLength={40} onChange={e => setName(e.target.value)} disabled={busy} /></label>
      <label>有效期<select value={days} onChange={e => setDays(Number(e.target.value))} disabled={busy}>
        <option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option>
      </select></label>
      <button className="settings-add" disabled={loading || busy || !name.trim()} onClick={() => void create()}>生成专用密钥</button>
    </div>
    {fresh && <div className="agent-terms-secret">
      <p>完整密钥仅在这次生成后可复制，离开页面后不能再次读取。</p>
      <label>新密钥<input type="password" readOnly value={fresh.token} autoComplete="off" /></label>
      <button className="settings-add" disabled={busy} onClick={() => void copy(fresh.token)}>复制密钥</button>
    </div>}
    <div className="settings-actions">
      <button className="settings-add" onClick={() => void copy(instructions)}>复制 agent 使用说明</button>
      <a href="/api/open/v1/openapi.json" target="_blank" rel="noreferrer">接口规范</a>
    </div>
    <details className="agent-terms-help"><summary>如何交给 agent 使用</summary>
      <p>生成并复制密钥，让 agent 存入私有环境变量 STUDENTBUDDY_TERMS_TOKEN，再把下面的说明交给它。也可以用仓库的 tools/import-agent-terms.mjs 导入桌面词条评审台导出的 JSON。</p>
      <textarea aria-label="agent 使用说明" readOnly value={instructions} rows={8} />
      <p>新词默认加入复习。应试模式沿用来源白名单；没有完整网页来源或来源不在范围内的词仍会保存，导入回执会说明当前视图是否显示。</p>
    </details>
    {error && <p role="alert" className="settings-hint warn">{error}</p>}
    {loading && <p className="settings-hint">读取密钥列表…</p>}
    {keys.length > 0 && <ul className="agent-terms-keys">{keys.map(key => {
      const inactive = key.revokedAt !== null || key.expiresAt <= Date.now();
      return <li key={key.id}>
        <div><strong>{key.name}</strong><code>{key.prefix}…</code>
          <span>{key.revokedAt ? '已撤销' : key.expiresAt <= Date.now() ? '已过期' : `有效至 ${new Date(key.expiresAt).toLocaleDateString()}`}</span>
          {key.lastUsedAt && <span>最近使用 {new Date(key.lastUsedAt).toLocaleString()}</span>}
        </div>
        <button className="settings-add" disabled={busy || inactive} onClick={() => void revoke(key)}>撤销</button>
      </li>;
    })}</ul>}
  </section>;
}
