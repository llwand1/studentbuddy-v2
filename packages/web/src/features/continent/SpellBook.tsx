/**
 * features/continent/SpellBook — 咒语书：从历史对话里挑一段当咒语（契约 `docs/SPELL-CHANT-SPEC.md` §3.2）。
 *
 * ★ 只读两个**既有**接口：`api.sessions.list()` 列书、`api.sessions.messages(id)` 取正文。零新路由。
 * ★ 空咒语（0 节）就地说清、不进吟唱、不消耗机会——「选了没反应」是本仓最忌的静默死路。
 * ★ 取数失败原样念出并可重试（ADR-5）。
 */
import { useEffect, useState } from 'react';
import type { Session } from '@sb/shared';
import { api } from '../../lib/api';
import { planSpell, spellTimeText, type SpellPlan } from './spell-chant-view';

interface Props {
  /** 这块地的词条名（判共鸣用） */
  term: string;
  onPick: (plan: SpellPlan, session: Session) => void;
  onClose: () => void;
}

/** 服务端行是 snake_case（`updated_at`），契约类型写的是 camelCase——两种都认，不为这点差异再开一条类型 */
function updatedAtOf(s: Session): string {
  return (s as Session & { updated_at?: string }).updated_at ?? s.updatedAt ?? '';
}

export function SpellBook({ term, onPick, onClose }: Props) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [emptyIds, setEmptyIds] = useState<Set<string>>(new Set());

  const load = async (): Promise<void> => {
    try {
      setError(null);
      setSessions(await api.sessions.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const pick = async (s: Session): Promise<void> => {
    if (loadingId) return;
    setLoadingId(s.id);
    setNote(null);
    try {
      const rows = await api.sessions.messages(s.id);
      const plan = planSpell(rows, term);
      if (plan.verses.length === 0) {
        setEmptyIds((prev) => new Set(prev).add(s.id));
        setNote(`「${s.title}」这本咒语是空的——里面没有文字提问，也没有可判分的题卡。换一本。`);
        return;
      }
      onPick(plan, s);
    } catch (e) {
      setNote(`翻开这本咒语失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="continent-modal spell-modal" role="dialog" aria-modal="true" aria-label="咒语书">
      <div className="continent-modal-card spell-card spell-book">
        <header className="continent-modal-head">
          <span className="continent-modal-title">
            咒语书
            <small>每一段对话都是一道咒语——选一段，把当初的提问再说一遍、当初的题再做一遍，就能对「{term}」释放</small>
          </span>
          <button className="continent-btn ghost" onClick={onClose}>
            合上
          </button>
        </header>

        {error && (
          <p className="continent-note">
            咒语书翻不开：{error}{' '}
            <button className="continent-btn ghost" onClick={() => void load()}>
              重试
            </button>
          </p>
        )}
        {sessions === null && !error && <p className="spell-dim">正在翻开咒语书…</p>}
        {sessions !== null && sessions.length === 0 && (
          <p className="spell-dim">咒语书还是空白的——先去对话页从一个感兴趣的问题聊起，聊过的对话会出现在这里。</p>
        )}

        {sessions && sessions.length > 0 && (
          <ul className="spell-list">
            {sessions.map((s) => {
              const empty = emptyIds.has(s.id);
              const when = spellTimeText(updatedAtOf(s));
              return (
                <li key={s.id}>
                  <button
                    className={empty ? 'spell-item empty' : 'spell-item'}
                    disabled={empty || loadingId !== null}
                    aria-busy={loadingId === s.id}
                    onClick={() => void pick(s)}
                  >
                    <i className="spell-item-rune" aria-hidden="true" />
                    <span className="spell-item-title">{s.title || '未命名对话'}</span>
                    <small className="spell-item-meta">
                      {loadingId === s.id ? '翻开中…' : empty ? '空咒语' : when}
                    </small>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {note && <p className="continent-note">{note}</p>}
      </div>
    </div>
  );
}
