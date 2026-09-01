/**
 * TermsPage — 词条库（忆域 v2：AI 自动词条库）。
 * 取代旧「背背背」翻卡页：AI 在对话/搜索中自动把重要词条入库，
 * 本页提供领域 Tab 浏览、搜索、手动添加、编辑释义、删除、重要度/使用次数查看。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type TermItem } from '../../lib/api';
import { CardsIcon, SearchIcon, PlusIcon } from '../../components/icons';
import './terms.css';

type DomainStat = { domain: string; count: number };

export function TermsPage() {
  const [stats, setStats] = useState<{ total: number; domains: DomainStat[]; today: number }>({
    total: 0,
    domains: [],
    today: 0,
  });
  const [terms, setTerms] = useState<TermItem[]>([]);
  const [domain, setDomain] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editDef, setEditDef] = useState('');
  const [editDomain, setEditDomain] = useState('');
  const [newTerm, setNewTerm] = useState('');
  const [newDef, setNewDef] = useState('');
  const [newDomain, setNewDomain] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [s, t] = await Promise.all([api.terms.domains(), api.terms.list(domain, keyword.trim() || undefined)]);
    setStats(s);
    setTerms(t);
  }, [domain, keyword]);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  const flash = (m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg(''), 2200);
  };

  const add = async () => {
    if (!newTerm.trim() || !newDef.trim() || busy) return;
    setBusy(true);
    try {
      await api.terms.add(newTerm.trim(), newDef.trim(), newDomain.trim() || undefined);
      setNewTerm('');
      setNewDef('');
      setNewDomain('');
      flash('已存入词条库');
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (t: TermItem) => {
    setEditing(t.id);
    setEditDef(t.definition);
    setEditDomain(t.domain);
  };

  const saveEdit = async (t: TermItem) => {
    if (!editDef.trim()) return;
    await api.terms.update(t.id, { definition: editDef.trim(), domain: editDomain.trim() || undefined });
    setEditing(null);
    flash('已更新');
    await reload();
  };

  const remove = async (id: string) => {
    await api.terms.remove(id);
    flash('已删除');
    await reload();
  };

  return (
    <div className="term-page">
      <div className="term-head">
        <h2>词条库</h2>
        <span className="term-sub">AI 会在对话中自动记住重要词条，之后回答会优先使用这些术语</span>
      </div>

      <div className="term-stats">
        <span className="term-stat">
          <b>{stats.total}</b> 词条
        </span>
        <span className="term-stat">
          <b>{stats.domains.length}</b> 领域
        </span>
        <span className="term-stat">
          <b>{stats.today}</b> 今日新增
        </span>
      </div>

      <div className="term-toolbar">
        <div className="term-tabs" role="tablist">
          <button className={domain === 'all' ? 'term-tab on' : 'term-tab'} onClick={() => setDomain('all')}>
            全部
          </button>
          {stats.domains.map((d) => (
            <button
              key={d.domain}
              className={domain === d.domain ? 'term-tab on' : 'term-tab'}
              onClick={() => setDomain(d.domain)}
            >
              {d.domain}
              <span className="term-tab-count">{d.count}</span>
            </button>
          ))}
        </div>
        <div className="term-search">
          <SearchIcon size={14} />
          <input placeholder="搜词条…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
      </div>

      <div className="term-list">
        {terms.length === 0 && (
          <div className="term-empty">
            <CardsIcon size={26} />
            <p>{keyword || domain !== 'all' ? '没有匹配的词条' : '词条库还是空的'}</p>
            <p className="term-empty-sub">
              AI 会在每次对话/搜索后自动把重要术语存进来；也可以手动添加。
            </p>
          </div>
        )}
        {terms.map((t) => (
          <div key={t.id} className="term-item">
            {editing === t.id ? (
              <div className="term-edit">
                <input value={editDomain} onChange={(e) => setEditDomain(e.target.value)} placeholder="领域（如 english / math）" />
                <textarea value={editDef} onChange={(e) => setEditDef(e.target.value)} rows={2} />
                <div className="term-edit-actions">
                  <button className="term-btn ok" onClick={() => void saveEdit(t)}>
                    保存
                  </button>
                  <button className="term-btn" onClick={() => setEditing(null)}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="term-main">
                  <div className="term-top">
                    <span className="term-name">{t.term}</span>
                    <span className="term-domain">{t.domain}</span>
                    {t.usage_count > 0 && <span className="term-used">已在对话中使用 {t.usage_count} 次</span>}
                  </div>
                  <div className="term-def">{t.definition}</div>
                  <div className="term-meta">
                    {t.source_title && <span>来自：{t.source_title.slice(0, 16)}</span>}
                    <span>{t.updated_at?.slice(0, 10)}</span>
                  </div>
                </div>
                <div className="term-side">
                  <div className="term-imp" title={`AI 标注重要度 ${Math.round(t.importance * 100)}%`}>
                    {/* gates:style-ok 数据驱动宽度走 CSS 变量（非硬编码样式） */}
                    <i style={{ ['--imp-w' as string]: `${Math.round(t.importance * 100)}%` }} />
                  </div>
                  <div className="term-actions">
                    <button className="term-btn" onClick={() => startEdit(t)}>
                      编辑
                    </button>
                    <button className="term-btn danger" onClick={() => void remove(t.id)}>
                      删除
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="term-add">
        <div className="term-add-title">手动添加词条</div>
        <div className="term-add-row">
          <input placeholder="词条（如 closure / 二重积分）" value={newTerm} onChange={(e) => setNewTerm(e.target.value)} />
          <input placeholder="领域（如 english / math，留空 general）" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} />
        </div>
        <div className="term-add-row">
          <input
            className="term-add-def"
            placeholder="释义"
            value={newDef}
            onChange={(e) => setNewDef(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <button className="term-btn primary" onClick={() => void add()} disabled={busy || !newTerm.trim() || !newDef.trim()}>
            <PlusIcon size={14} /> 添加
          </button>
        </div>
      </div>

      {msg && <div className="term-msg">{msg}</div>}
    </div>
  );
}
