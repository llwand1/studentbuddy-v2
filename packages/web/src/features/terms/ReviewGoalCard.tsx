/**
 * ReviewGoalCard — 自定义复习目标（v1.2，契约 `docs/EBBINGHAUS-SPEC.md` §10）。
 *
 * 背景：复习节奏原本完全由曲线决定——同一时刻到期的常常只有 3~5 条，面板显示「待复习 3」，
 * 用户想多背就只能干等。本卡给用户一个**日目标条数**（百词斩式计数）＋**优先领域**。
 *
 * ★ 本组件只管**目标本身**（条数 + 优先领域）；队列怎么补位是服务端的事（§10.3），
 *   前端**不自己拼队列**——那样就会出现"界面说有 30 条、服务端只给 8 条"。
 * ★ 进度一律用 `@sb/shared` 的 `reviewGoalProgress`（前后端同一份判据）：
 *   前端自己写一次 `done >= target`，迟早与服务端分叉成「进度条满了但队列还有货」。
 * ★ `count = 0` 是**合法值**（＝关闭自定义目标，队列退回只放到期）。所以输入框允许 0，
 *   文案也要说清"关闭"，不能写成"必须大于 0"。
 * ★ 领域多选**不影响真账段**（§10.4）：优先只作用于"提前背 / 重复巩固"两段的段内排序。
 *   文案必须说清这一点，否则用户会以为勾了 `cs` 就看不到别的领域的老账了。
 * ★ 保存以**服务端回写值**为准（`setGoal` 的返回值）：用户输 9999 时界面必须显示 200，
 *   而不是显示他自己输的那个数。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { REVIEW_GOAL_MAX, reviewGoalProgress, type ReviewGoal } from '@sb/shared';

/** 常用目标数（点一下就设，省得每次敲数字） */
const GOAL_PRESETS = [10, 20, 30, 50];

interface DomainRow {
  domain: string;
  count: number;
}

/** 本地钳位只为即时反馈；**权威值仍以服务端回写为准**（归一实现只有 `shared/review-goal.ts` 一份） */
function clampCount(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.trunc(n), 0), REVIEW_GOAL_MAX);
}

export function ReviewGoalCard({
  doneCards,
  poolSize,
  onChanged,
}: {
  /** 今日**张数**（含重复打卡）——进度的分子，来自队列响应（与服务端同源） */
  doneCards: number;
  /** 可进队列的池子大小（在范围内且未毕业）——用来解释"为什么凑不满" */
  poolSize: number;
  onChanged?: () => void;
}) {
  const [goal, setGoal] = useState<ReviewGoal | null>(null);
  const [rows, setRows] = useState<DomainRow[]>([]);
  const [count, setCount] = useState('0');
  const [domains, setDomains] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const [g, stats] = await Promise.all([api.terms.goal(), api.terms.domains()]);
    setGoal(g);
    setCount(String(g.count));
    setDomains(g.domains);
    // 空领域不列出来：没有词条就没有可优先的东西，列出来只是噪音（同 ReviewScopePicker 取向）
    setRows(stats.domains.filter((d) => d.count > 0));
  }, []);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  /** 保存。`next` 只覆盖要改的字段（点领域时不该顺手把没提交的条数也写进去） */
  const save = async (next?: Partial<ReviewGoal>) => {
    if (busy) return;
    setBusy(true);
    setMsg('');
    try {
      const saved = await api.terms.setGoal({
        count: next?.count ?? clampCount(count),
        domains: next?.domains ?? domains,
      });
      // ★ 以回写值刷新本地（服务端可能钳过位）
      setGoal(saved);
      setCount(String(saved.count));
      setDomains(saved.domains);
      setMsg(saved.count > 0 ? `已设为每天 ${saved.count} 条` : '已关闭自定义目标');
      onChanged?.();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const toggleDomain = (name: string) => {
    const next = domains.includes(name) ? domains.filter((d) => d !== name) : [...domains, name];
    setDomains(next); // 先上屏，再落库（失败时 `save` 会把 msg 打出来，用户看得见）
    void save({ domains: next });
  };

  const progress = goal ? reviewGoalProgress(goal, doneCards) : null;
  const pct = progress && progress.target > 0 ? Math.round((progress.done / progress.target) * 100) : 0;

  return (
    <div className="rv-goal">
      <div className="rv-goal-head">
        <b>今日目标</b>
        {progress && (
          <span className={progress.reached ? 'rv-goal-ok' : 'rv-goal-hint'}>
            {progress.target === 0
              ? '未设目标 · 只按遗忘曲线复习'
              : progress.reached
                ? `已达成 ${progress.done} / ${progress.target}`
                : `还差 ${progress.remaining} 条 · 已完成 ${progress.done} / ${progress.target}`}
          </span>
        )}
      </div>

      {progress && progress.target > 0 && (
        <div className="rv-goal-bar" title={`今日已复习 ${progress.done} 张，目标 ${progress.target} 张`}>
          {/* gates:style-ok 数据驱动宽度走 CSS 变量（非硬编码样式） */}
          <i className="rv-goal-fill" style={{ ['--rv-goal-pct' as string]: `${pct}%` }} />
        </div>
      )}

      <p className="rv-goal-tip">
        到期的词条不够时，会先补**还没到期**的，再补**今天已背过的**——所以设了目标就一定能背够。
        优先领域只影响这两段的排序，**不会让别的领域的老账排到后面**。
      </p>

      <div className="rv-goal-row">
        <span className="rv-goal-label">每天背</span>
        <input
          className="rv-goal-input"
          type="number"
          min={0}
          max={REVIEW_GOAL_MAX}
          value={count}
          disabled={busy}
          onChange={(e) => setCount(e.target.value)}
          aria-label="每日复习目标条数"
        />
        <span className="rv-goal-label">条</span>
        <div className="rv-goal-presets">
          {GOAL_PRESETS.map((n) => (
            <button
              key={n}
              className={goal?.count === n ? 'rv-goal-chip on' : 'rv-goal-chip'}
              disabled={busy}
              onClick={() => {
                setCount(String(n));
                void save({ count: n });
              }}
            >
              {n}
            </button>
          ))}
        </div>
        <button className="rv-btn ok" disabled={busy} onClick={() => void save()}>
          保存
        </button>
      </div>

      {rows.length > 0 && (
        <div className="rv-goal-domains">
          <span className="rv-goal-label">优先领域</span>
          <div className="rv-goal-chips">
            {rows.map((r) => (
              <button
                key={r.domain}
                className={domains.includes(r.domain) ? 'rv-goal-chip on' : 'rv-goal-chip'}
                disabled={busy}
                title={domains.includes(r.domain) ? `取消优先「${r.domain}」` : `把「${r.domain}」设为优先`}
                onClick={() => toggleDomain(r.domain)}
              >
                {r.domain}
                <span className="rv-goal-num">{r.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ★ 池子不够时**如实说出来**：否则用户设了 30 条、队列只出现 8 条，会以为功能坏了 */}
      {progress && progress.target > poolSize && (
        <div className="rv-goal-msg">
          可复习的词条只有 {poolSize} 条，不够 {progress.target} 条——队列会短于目标，属正常。
        </div>
      )}

      {msg && <div className="rv-goal-msg">{msg}</div>}
    </div>
  );
}
