/**
 * DomainBar — 词条库的领域条（v19：领域与词条 CRUD 对等）。
 *
 * 职责：领域 Tab 切换 + 领域管理（新建 / 改名 / 改说明 / 删除）。
 *
 * ★ 为什么抽成独立文件：`TermsPage` 已 212 行，贴着 web 组件 ≤300 行红线（AGENTS 工程红线），
 *   这套领域管理交互塞不进去。
 * ★ 为什么编辑控件放在一个可折叠的「管理领域」面板里、而不是压在 Tab 上：Tab 是**筛选器**，
 *   点一下 = 切列表。把输入框叠在 Tab 上会让这个动作的语义变歧义（切列表还是改名？），
 *   且领域名常被误触改成半个字。面板是**显式的改动区**，Tab 保持"只看不改"。
 * ★ 每行只有一个「保存」同时管改名与说明：这两段总是一起被反复调，拆两个按钮反而容易
 *   只点一个、以为两个都生效。内部按需分别调 `domainNote`（改说明）/ `domainRename`（改名）。
 * ★ 删除用**两段式按钮**（点「删除」→ 变「确认删除？」+「取消」）而非 `window.confirm`：
 *   原生弹窗在本地 Web 里观感割裂，且词条会迁 general **不丢数据**，风险等级不需要模态拦截。
 */
import { useState } from 'react';
import { api, ApiError } from '../../lib/api';

/**
 * 领域 Tab 数据（= `GET /api/terms/domains` 响应里的 domains 元素；含空领域 count=0）。
 *
 * `mentionCount`（契约 MEMORY-TREND-SPEC §2）：该领域内词条的**总**提及数。
 * ★ 它与 `count`（词条数）**不是一回事，也不能互相换算**——`count` 回答"库里有多少词"，
 *   `mentionCount` 回答"这些词被用起来过多少次"。两个维度都要看得见：一个领域可能词条很多
 *   但从没被提及（存了不用），也可能只 2 个词条却撑起大半提及（真正的学习重心）。
 */
export type DomainStat = { domain: string; count: number; note: string; mentionCount: number };

interface Draft {
  name: string;
  note: string;
}

export function DomainBar({
  domains,
  active,
  onPick,
  onChanged,
}: {
  domains: DomainStat[];
  active: string;
  onPick: (domain: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [newName, setNewName] = useState('');
  const [newNote, setNewNote] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const draftOf = (d: DomainStat): Draft => drafts[d.domain] ?? { name: d.domain, note: d.note };
  const setDraft = (d: DomainStat, next: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [d.domain]: { ...draftOf(d), ...next } }));

  /** 统一动作壳：busy 防连点、错误落 msg（不弹窗、不静默，ADR-5）、成功后重拉列表并清草稿。 */
  const run = async (fn: () => Promise<string>, clearKey?: string) => {
    if (busy) return;
    setBusy(true);
    setMsg('');
    try {
      const text = await fn();
      setMsg(text);
      if (clearKey) {
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[clearKey];
          return next;
        });
      }
      await onChanged();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    const name = newName.trim();
    if (!name || busy) return;
    void run(async () => {
      const row = await api.terms.domainAdd(name, newNote.trim() || undefined);
      setNewName('');
      setNewNote('');
      onPick(row.name);
      return `已新建领域「${row.name}」`;
    });
  };

  const save = (d: DomainStat) => {
    const draft = draftOf(d);
    void run(async () => {
      const parts: string[] = [];
      const note = draft.note.trim();
      if (note !== d.note) {
        await api.terms.domainNote(d.domain, note);
        parts.push('说明已更新');
      }
      const to = draft.name.trim();
      if (to && to !== d.domain) {
        const r = await api.terms.domainRename(d.domain, to);
        parts.push(
          `已改名「${r.from}」→「${r.to}」${r.moved > 0 ? `，${r.moved} 条词条随迁` : ''}` +
            (r.merged ? '（并入已有领域）' : ''),
        );
      }
      return parts.length > 0 ? parts.join('；') : '没有改动';
    }, d.domain);
  };

  const remove = (d: DomainStat) => {
    void run(async () => {
      const r = await api.terms.domainRemove(d.domain);
      onPick('all'); // 删掉的正是当前筛选域时必须回「全部」，否则列表被留在一个不存在的域上
      return `已删除领域「${r.name}」，${r.moved} 条词条转入「${r.target}」`;
    });
  };

  return (
    <div className="term-tabs-wrap">
      <div className="term-tabs" role="tablist">
        <button className={active === 'all' ? 'term-tab on' : 'term-tab'} onClick={() => onPick('all')}>
          全部
        </button>
        {domains.map((d) => (
          <button
            key={d.domain}
            className={active === d.domain ? 'term-tab on' : 'term-tab'}
            // ★ 徽标仍只显示**词条数**：Tab 是筛选器，塞两个无标签的数字会变成"math 12·87"这种
            //   读不懂的形状。总提及数放进 title（悬停即得）+ 管理面板的带标签字段（改动区才谈数字）。
            title={[d.note, `${d.count} 个词条 · 共提及 ${d.mentionCount} 次`].filter(Boolean).join('\n')}
            onClick={() => onPick(d.domain)}
          >
            {d.domain}
            <span className="term-tab-count">{d.count}</span>
          </button>
        ))}
        <button
          className={open ? 'term-tab on' : 'term-tab'}
          onClick={() => {
            setOpen((v) => !v);
            setMsg('');
            setPendingDelete(null);
          }}
        >
          {open ? '收起管理' : '管理领域'}
        </button>
      </div>

      {open && (
        <div className="term-domain-panel">
          {domains.length === 0 && <p className="term-domain-empty">还没有领域。可以新建一个，再往里放词条。</p>}
          {domains.map((d) => {
            const draft = draftOf(d);
            const isDefault = d.domain === 'general';
            return (
              <div key={d.domain} className="term-domain-row">
                <input
                  className="term-domain-name"
                  value={draft.name}
                  aria-label={`领域名 ${d.domain}`}
                  onChange={(e) => setDraft(d, { name: e.target.value })}
                />
                <input
                  className="term-domain-note"
                  placeholder="说明（可空）"
                  value={draft.note}
                  aria-label={`领域说明 ${d.domain}`}
                  onChange={(e) => setDraft(d, { note: e.target.value })}
                />
                {/* 派生只读字段：`count` 来自词条表、`mentionCount` 来自 usage_count 聚合。
                    两个都不接受编辑（改数字没有意义——它们是你用出来的，不是填出来的）。 */}
                <span className="term-domain-count">
                  {d.count} 词条 · 提及 {d.mentionCount} 次
                </span>
                <button className="term-btn" disabled={busy} onClick={() => save(d)}>
                  保存
                </button>
                {pendingDelete === d.domain ? (
                  <>
                    <button className="term-btn danger" disabled={busy} onClick={() => remove(d)}>
                      确认删除
                    </button>
                    <button className="term-btn" onClick={() => setPendingDelete(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    className="term-btn"
                    disabled={busy || isDefault}
                    title={isDefault ? 'general 是默认领域（词条的兜底归属），不能删除' : '删除后词条转入 general'}
                    onClick={() => setPendingDelete(d.domain)}
                  >
                    删除
                  </button>
                )}
              </div>
            );
          })}

          <div className="term-domain-row new">
            <input
              className="term-domain-name"
              placeholder="新领域名（如 math）"
              value={newName}
              aria-label="新领域名"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
            <input
              className="term-domain-note"
              placeholder="说明（可空）"
              value={newNote}
              aria-label="新领域说明"
              onChange={(e) => setNewNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
            <button className="term-btn primary" disabled={busy || !newName.trim()} onClick={add}>
              新建
            </button>
          </div>
        </div>
      )}

      {msg && <div className="term-domain-msg">{msg}</div>}
    </div>
  );
}
