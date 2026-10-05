/**
 * ExamModeCard — 应试模式开关与范围（契约 docs/EXAM-MODE-SPEC.md §5，2026-10-04 起）。
 *
 * 交互取向：**点选即存**（同 QuizRealFirstCard / QuizImageCard），不设「保存」按钮——
 * 范围这件事是边想边勾的，多一个按钮就多一次「改了没存」的坑。
 * ★ 所有回显都用服务端回读值：域名归一化、非法丢弃、条数钳位都在服务端做，
 *   前端自己算一份就会漂（两处真相源）。
 */
import { useEffect, useState } from 'react';
import type { ExamPacksView, ExamScopeSetting } from '@sb/shared';
import { MAX_EXAM_CUSTOM_HOSTS } from '@sb/shared';
import { api } from '../../lib/api';
import { setExamScopeCached } from '../exam/useExamScope';
import './settings.css';

export function ExamModeCard({ flash }: { flash: (ok: boolean, text: string) => void }) {
  const [on, setOn] = useState(false);
  const [scope, setScope] = useState<ExamScopeSetting>({ packs: [], custom: [] });
  const [meta, setMeta] = useState<ExamPacksView | null>(null);
  const [hosts, setHosts] = useState<string[]>([]);
  const [directSites, setDirectSites] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [probe, setProbe] = useState('');

  useEffect(() => {
    Promise.all([api.settings.examPacks(), api.settings.examMode()])
      .then(([packsView, mode]) => {
        setMeta(packsView);
        setOn(mode.on);
        setScope(mode.scope);
        setHosts(mode.hosts);
        setDirectSites(mode.directSites);
      })
      .catch((e) => flash(false, e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const apply = async (next: ExamScopeSetting) => {
    setBusy(true);
    try {
      const r = await api.settings.saveExamScope(next);
      setScope(r.scope);
      setHosts(r.hosts);
      setDirectSites(r.directSites);
      setOn(r.on);
      setExamScopeCached({ on: r.on, scope: r.scope, summary: r.summary, hosts: r.hosts, directSites: r.directSites });
      if (r.rejectedCustom > 0) flash(false, `有 ${r.rejectedCustom} 条域名不合法，已丢弃（填站点域名即可，不用带 https:// 或路径）`);
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (next: boolean) => {
    if (busy || next === on) return;
    setBusy(true);
    try {
      const r = await api.settings.saveExamMode(next);
      setOn(r.on);
      setExamScopeCached(r);
      flash(true, r.on ? `已开启：外部资料只从范围内的站取（${r.summary}）` : '已关闭：恢复不设来源边界');
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const togglePack = (id: string) => {
    const packs = scope.packs.includes(id) ? scope.packs.filter((p) => p !== id) : [...scope.packs, id];
    void apply({ ...scope, packs });
  };

  const addHost = () => {
    const raw = draft.trim();
    if (!raw) return;
    if (scope.custom.includes(raw)) {
      setDraft('');
      return;
    }
    void apply({ ...scope, custom: [...scope.custom, raw] });
    setDraft('');
  };

  const testScope = async () => {
    setBusy(true);
    setProbe('正在按你选的范围搜一次…');
    try {
      const r = await api.settings.testSearch('高考 数学 真题');
      setProbe(
        r.ok
          ? `范围内命中 ${r.count} 条${r.scope ? `，范围外已过滤 ${r.scope.dropped} 条` : ''}（通道 ${r.providers.join('、') || '缓存'}）`
          : `范围内 0 条${r.failed.length ? `；通道回报：${r.failed[0]?.slice(0, 60)}` : ''}——范围太窄或本站在挡爬虫，见下方登记注`,
      );
    } catch (e) {
      setProbe(`这次没测成：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const state = loading ? '读取中…' : busy ? '保存中…' : `当前：${on ? '开启' : '关闭'}`;

  return (
    <section className="settings-sec">
      <h3>应试模式</h3>
      <p className="settings-hint">
        开启后，<b>凡是从网上取的东西都只在你选定的站点范围内</b>：出题的参考资料、现场搜集的真题、
        聊天里的联网检索、右侧资料架与阅读页、找视频，范围外的一条都不呈现。
        <b>范围内搜不到真题时如实告诉你</b>，不会用 AI 题冒充真题。
        关闭时一切照旧，不改变任何既有行为。
      </p>

      <div className="quiz-mix-presets">
        <button className={on ? 'quiz-mix-chip active' : 'quiz-mix-chip'} disabled={loading || busy} onClick={() => void pick(true)}>
          开启（按范围取资料）
        </button>
        <button className={!on ? 'quiz-mix-chip active' : 'quiz-mix-chip'} disabled={loading || busy} onClick={() => void pick(false)}>
          关闭
        </button>
      </div>

      <h4>考试范围（勾选即生效）</h4>
      <div className="quiz-mix-presets">
        {(meta?.packs ?? []).map((p) => {
          const picked = scope.packs.includes(p.id);
          return (
            <button
              key={p.id}
              className={picked ? 'quiz-mix-chip active' : 'quiz-mix-chip'}
              disabled={loading || busy}
              title={p.hint}
              onClick={() => togglePack(p.id)}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <h4>自己加站点</h4>
      <p className="settings-hint">
        填站点域名即可（如 <code>jyeoo.com</code>），不用带 <code>https://</code> 或路径；子域自动包含在内。
        上限 {MAX_EXAM_CUSTOM_HOSTS} 条。
      </p>
      <div className="settings-form">
        <input
          value={draft}
          placeholder="例：zzonline.example.com"
          disabled={loading || busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addHost();
          }}
        />
        <button className="settings-add" disabled={loading || busy || !draft.trim()} onClick={addHost}>
          加入范围
        </button>
      </div>
      {scope.custom.length > 0 && (
        <div className="quiz-mix-presets">
          {scope.custom.map((h) => (
            <button
              key={h}
              className="quiz-mix-chip"
              disabled={loading || busy}
              title="点一下移出范围"
              onClick={() => void apply({ ...scope, custom: scope.custom.filter((c) => c !== h) })}
            >
              {h} ✕
            </button>
          ))}
        </div>
      )}

      <h4>范围内共 {hosts.length} 个站</h4>
      <div className="quiz-mix-presets">
        {(meta?.sources ?? [])
          .filter((s) => hosts.includes(s.host))
          .map((s) => (
            <span key={s.host} className="quiz-mix-chip" title={`${s.note}｜${s.host}`}>
              {s.label}·{s.tier === 'question' ? '题源' : '资料'}
              {s.direct ? '·直达' : ''}
            </span>
          ))}
      </div>
      <p className="settings-hint">
        带<b>直达</b>的 {directSites.length} 个：{directSites.join('、') || '（这一档里没有）'}。
        直达＝出题时直接打这站自己的检索入口，不靠通用搜索引擎（实测它理都不理「只搜某站」这种限制）。
        <b>题源</b>＝逐个真打过、页面正文里确有题干与答案；<b>资料</b>＝只当背景材料。悬停看每站的实测读数。
      </p>
      <div className="settings-actions">
        <button className="quiz-mix-chip" disabled={loading || busy || hosts.length === 0} onClick={() => void testScope()}>
          按这个范围试搜一次
        </button>
        <span className="settings-state on">{probe || '不烧额度：只发一次真实检索，回多少条都照实说'}</span>
      </div>

      <div className="settings-actions">
        <span className={on ? 'settings-state on' : 'settings-state'}>{state}</span>
      </div>
    </section>
  );
}
