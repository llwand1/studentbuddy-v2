/**
 * ReviewPanel — 词条复习面板（v23 艾宾浩斯遗忘曲线，契约 `docs/EBBINGHAUS-SPEC.md`）。
 *
 * 挂在词条页顶部：一眼看见**今天欠多少、最久欠了几天**，然后在页内直接还账（记住了 / 忘了）。
 * ★ **天数与状态一律用服务端算好的 `review` 字段**，本组件不自己算（唯一实现在
 *   `shared/ebbinghaus.ts`）——前端重算一次，就迟早出现「徽标说逾期、队列里没有它」。
 *
 * 交互三条刻意的取舍：
 *  1. **先翻牌再看释义**（默认盖住）：复习的核心是「先回忆再对照」，一上来就把释义摊开
 *     等于把复习降级成阅读。故默认只给词名与领域，点「看释义」才展开。
 *  2. **不做乐观切态**：打卡结果以服务端返回为准再更新队列（并发双端点击由服务端裁决，
 *     与 `useChoiceQueue` 同手法）。本地先删会让失败那次看起来像成功了。
 *  3. **队列顺序照搬服务端**（逾期久的在前），前端**不重排**——「先还旧账」是服务端口径，
 *     前端再排一次就可能有第二套顺序。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type ReviewOverview, type ReviewTermItem } from '../../lib/api';
import { ClockIcon, CheckIcon } from '../../components/icons';
import { ReviewScopePicker } from './ReviewScopePicker';

const QUEUE_LIMIT = 20;

/** 复习节点文案（与 `REVIEW_INTERVALS_DAYS` 对应；改序列时必须同步改这里） */
const SCHEDULE_TEXT = '1 / 2 / 4 / 7 / 15 / 30 / 60 天';

function badgeClass(s: ReviewTermItem['review']): string {
  if (s.status === 'overdue') return 'rv-badge rv-badge-overdue';
  if (s.status === 'due') return 'rv-badge rv-badge-due';
  return 'rv-badge';
}

export function ReviewPanel({ domain = 'all', onChanged }: { domain?: string; onChanged?: () => void }) {
  const [overview, setOverview] = useState<ReviewOverview | null>(null);
  const [queue, setQueue] = useState<ReviewTermItem[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * 队列默认**收起**（v23.1）：本页的主体是词条库，而队列一展开就是 20 条（实测 2073px），
   * 会把词条库本体连同搜索/添加一起挤出可视区。收起态保留一行欠账摘要，信息不丢。
   */
  const [open, setOpen] = useState(false);
  /**
   * 复习范围面板（v28）：默认**收起**，但它与队列是**两个独立的开关**——
   * 范围是"该背哪些"（低频、一次性），队列是"今天还哪些账"（高频）。
   * 合成一个开关的话，每次想调范围都得先展开 20 条队列，页面被挤走。
   */
  const [scopeOpen, setScopeOpen] = useState(false);
  const [revealed, setRevealed] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, q] = await Promise.all([api.terms.overview(domain), api.terms.queue(QUEUE_LIMIT, domain)]);
      setOverview(ov);
      setQueue(q);
      setRevealed([]);
    } finally {
      setLoading(false);
    }
  }, [domain]);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  const mark = async (id: string, remembered: boolean) => {
    if (busy) return;
    setBusy(id);
    try {
      await api.terms.mark(id, remembered);
      setQueue((prev) => prev.filter((t) => t.id !== id));
      const ov = await api.terms.overview(domain);
      setOverview(ov);
      onChanged?.(); // stage 变了 ⇒ 外层列表的「N 天没复习」也要跟着变
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) =>
    setRevealed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const peak = Math.max(1, ...(overview?.recent ?? []).map((d) => d.done));

  return (
    <div className="rv-panel">
      <div className="rv-head">
        <ClockIcon size={15} />
        <b>复习计划</b>
        {/* 收起态也要回答「今天欠多少」——摘要与展开态同源（`overview`），不另算一套口径 */}
        {overview && (
          <span className="rv-sum">
            {/* ★ 复习池为空（v28 默认全不选）时**不能说"逾期 0"**：那读起来像"今天没账"，
                而真实情况是"你还没说要背什么"。两句话的下一步动作完全不同。 */}
            {overview.total === 0 ? (
              <span className="rv-sum-hint">还没选复习范围</span>
            ) : (
              <>
                <span className="rv-sum-warn">逾期 {overview.overdue}</span>
                <span>待复习 {overview.due}</span>
                <span>今日已复习 {overview.todayDone}</span>
              </>
            )}
          </span>
        )}
        {/* 展开/收起是**本页布局的必需开关**（不是可选装饰）：展开才会让队列参与高度分配 */}
        <button className="rv-toggle" aria-expanded={scopeOpen} onClick={() => setScopeOpen((o) => !o)}>
          {scopeOpen ? '收起范围' : '复习范围'}
        </button>
        <button className="rv-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? '收起队列' : '展开队列'}
          <i className={open ? 'rv-caret on' : 'rv-caret'} />
        </button>
      </div>

      {scopeOpen && (
        <ReviewScopePicker
          onChanged={() => {
            // 范围一变，概览/队列/词条行的徽标**全都**要跟着变（范围是本页最大的一个开关）
            void reload().catch(() => undefined);
            onChanged?.();
          }}
        />
      )}

      {loading && !overview && <div className="rv-loading">正在算欠账…</div>}

      {open && overview && (
        <>
          <div className="rv-sched">经典节点 {SCHEDULE_TEXT}</div>
          <div className="rv-stats">
            <span className="rv-stat">
              <b>{overview.due}</b> 待复习
            </span>
            <span className="rv-stat rv-stat-warn">
              <b>{overview.overdue}</b> 逾期
            </span>
            <span className="rv-stat">
              <b>{overview.todayDone}</b> 今日已复习
            </span>
            <span className="rv-stat">
              <b>{overview.maxOverdueDays}</b> 天最久欠账
            </span>
            <span className="rv-stat">
              <b>{overview.mastered}</b> 已入长期记忆
            </span>
          </div>

          <div className="rv-bars" title="近 7 天每日复习量">
            {overview.recent.map((d) => (
              <span key={d.day} className="rv-bar-wrap">
                {/* gates:style-ok 数据驱动高度走 CSS 变量（非硬编码样式） */}
                <i className="rv-bar" style={{ ['--rv-h' as string]: `${Math.round((d.done / peak) * 100)}%` }} />
                <em>{d.day.slice(5)}</em>
              </span>
            ))}
          </div>
        </>
      )}

      {open && (
        <>
          <div className="rv-queue-head">今日队列（先还旧账）</div>

      {!loading && queue.length === 0 && (
        <div className="rv-empty">
          <CheckIcon size={18} />
          {/* ★ 三句话对应三种完全不同的下一步（v28 加了第一条）：
              没选范围 → 去选；有欠账但队列空 → 刷新；真的没到期 → 什么都不用做。
              全说成"今天没有要复习的词条"会让第一种情况永远无解。 */}
          <span>
            {overview && overview.total === 0
              ? '还没选复习范围——点上方「复习范围」勾选要背的领域或词条'
              : overview && overview.due > 0
                ? '这一批复习完了，刷新看还有没有'
                : '今天没有到期要复习的词条'}
          </span>
        </div>
      )}

      <div className="rv-queue">
        {queue.map((t) => (
          <div key={t.id} className={`rv-item rv-${t.review.status}`}>
            <div className="rv-item-main">
              <div className="rv-item-top">
                <span className="rv-term">{t.term}</span>
                <span className="rv-domain">{t.domain}</span>
                <span className={badgeClass(t.review)}>
                  {t.review.status === 'overdue'
                    ? `逾期 ${t.review.overdueDays} 天`
                    : t.review.status === 'due'
                      ? '今天到期'
                      : '待复习'}
                </span>
                <span className="rv-days">{t.review.daysSince} 天没复习</span>
              </div>
              {revealed.includes(t.id) ? (
                <div className="rv-def">{t.definition}</div>
              ) : (
                <button className="rv-btn" onClick={() => toggle(t.id)}>
                  看释义
                </button>
              )}
              <div className="rv-meta">
                第 {Math.min(t.review.stage + 1, 7)}/7 节点 · 记忆保持 ≈ {Math.round(t.review.retention * 100)}%
                {t.review.basis === 'created' && ' · 还没复习过（按入库时间算）'}
              </div>
            </div>
            <div className="rv-item-actions">
              <button className="rv-btn ok" disabled={busy === t.id} onClick={() => void mark(t.id, true)}>
                记住了
              </button>
              <button className="rv-btn danger" disabled={busy === t.id} onClick={() => void mark(t.id, false)}>
                忘了
              </button>
            </div>
          </div>
        ))}
          </div>
        </>
      )}
    </div>
  );
}
