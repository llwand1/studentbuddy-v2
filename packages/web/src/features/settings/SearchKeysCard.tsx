/**
 * SearchKeysCard — 联网搜索 key 配置（响应只回已配置/未配置，密钥明文与密文都不出前端）。
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import './settings.css';

type KeyType = 'exa' | 'tavily' | 'zhipu';
const KEY_FIELDS: Array<{ type: KeyType; label: string; placeholder: string }> = [
  { type: 'exa', label: 'Exa（主）', placeholder: 'EXA_API_KEY' },
  { type: 'tavily', label: 'Tavily（备）', placeholder: 'TAVILY_API_KEY' },
  { type: 'zhipu', label: '智谱（国产兜底）', placeholder: 'ZHIPU_API_KEY' },
];

export function SearchKeysCard({ flash }: { flash: (ok: boolean, text: string) => void }) {
  const [configured, setConfigured] = useState<Record<KeyType, boolean>>({ exa: false, tavily: false, zhipu: false });
  const [vals, setVals] = useState<Record<KeyType, string>>({ exa: '', tavily: '', zhipu: '' });
  const [test, setTest] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.settings
      .searchKeys()
      .then((r) => setConfigured(r.configured))
      .catch((e) => flash(false, e instanceof Error ? e.message : String(e)));
  }, []);

  const save = async () => {
    const patch = Object.fromEntries(
      KEY_FIELDS.map((f) => [f.type, vals[f.type].trim()]).filter(([, v]) => v),
    ) as Partial<Record<KeyType, string>>;
    if (Object.keys(patch).length === 0) {
      flash(false, '请先填入要保存的 key');
      return;
    }
    setBusy(true);
    try {
      const r = await api.settings.saveSearchKeys(patch);
      setVals({ exa: '', tavily: '', zhipu: '' });
      setConfigured(r.configured);
      flash(true, '已保存（密文存储）');
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 真机自检：国产网络可用性必须实测，不接受纸面判断。 */
  const runTest = async () => {
    setBusy(true);
    setTest('自检中…');
    try {
      const r = await api.settings.testSearch();
      setTest(r.ok ? `命中 ${r.count} 条（来源 ${r.providers.join('、')}）` : `未取到结果：${r.failed.join('; ')}`);
    } catch (e) {
      setTest(`自检请求失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-sec">
      <h3>联网搜索</h3>
      <p className="settings-hint">三家 key 全未配置时自动走 DuckDuckGo 免费通道兜底；key 加密存本地库，只回显配置状态。</p>
      <div className="settings-keys">
        {KEY_FIELDS.map((f) => (
          <div key={f.type} className="settings-key-row">
            <span>{f.label}</span>
            <input
              type="password"
              placeholder={configured[f.type] ? '已配置（留空则不改动）' : f.placeholder}
              value={vals[f.type]}
              onChange={(e) => setVals((v) => ({ ...v, [f.type]: e.target.value }))}
            />
            <span className={configured[f.type] ? 'settings-state on' : 'settings-state'}>
              {configured[f.type] ? '已配置' : '未配置'}
            </span>
          </div>
        ))}
      </div>
      <div className="settings-actions">
        <button className="settings-add" disabled={busy} onClick={() => void save()}>
          保存
        </button>
        <button className="settings-add" disabled={busy} onClick={() => void runTest()}>
          测试连通
        </button>
      </div>
      {test && <div className="settings-test">{test}</div>}
    </section>
  );
}
