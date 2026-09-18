/**
 * CoachDock — 复习督促小窗（老板 2026-09-18 拍板的 **B+C+E** 三合一）。
 *
 * 形态：**一个组件的两个状态**，不是两个功能——
 *   折叠态 = 右下角任务胶囊（B）：一行数字，零打扰；
 *   展开态 = 右侧抽屉（C）：上面是卡片流（E），下面是输入区。
 *
 * 三条状态纪律：
 *  ① **数字只有一个来源**：胶囊与抽屉头部都读服务端 `/coach/state` 的快照（`shared/coach.ts`
 *     的判定），本组件不自己算「欠几条」——前端算一次就会出现「胶囊说 12、抽屉说 9」。
 *  ② **流水的真相在服务端**：本地只做「乐观插入 + 按 id 合并」（`coach-cards.ts`），
 *     `done` 之后整表重拉。理由同 `useChoiceQueue`：本仓不搞两套状态。
 *  ③ **常连一条 SSE**：token 只在流里出现一次，断线重连由 `lib/sse-client` 负责
 *     （指数退避 + seq 去重 + `/live` 快照对齐）。这条连接很轻（15s 一个 ping），
 *     换来的是「打开就能发、发了就有字」，比"打开才连"值。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CoachCard, CoachSnapshot } from '@sb/shared';
import { api, type ReviewTermItem } from '../../lib/api';
import { COACH_LIVE_URL, COACH_STREAM_URL, coachApi } from '../../lib/api-coach';
import { connectSse } from '../../lib/sse-client';
import { MinusIcon } from '../../components/icons';
import { CoachCapsule } from './CoachCapsule';
import { CoachComposer } from './CoachComposer';
import { CoachFeed } from './CoachFeed';
import { mergeCards, withStreaming } from './coach-cards';
import './coach.css';

/** 队列取几条：小窗一屏能横向滚动的量，再多就该回词条页的复习面板处理 */
const QUEUE_LIMIT = 20;
/** 快照轮询间隔：天级判定的功能，一分钟一次足够（要的是"数字跟着变"，不是秒级同步） */
const STATE_POLL_MS = 60_000;

export function CoachDock() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<CoachSnapshot | null>(null);
  const [nudge, setNudge] = useState(false);
  const [cards, setCards] = useState<CoachCard[]>([]);
  /** 正在流的那段文本（临时卡；`done` 后由落库的真卡接管） */
  const [stream, setStream] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [queue, setQueue] = useState<ReviewTermItem[]>([]);
  const [busyTerm, setBusyTerm] = useState<string | null>(null);

  const refreshState = useCallback(async () => {
    try {
      const s = await coachApi.state();
      setSnapshot(s.snapshot);
      setNudge(s.nudge.should);
    } catch {
      // 服务没起 / 未登录超时：小窗静默降级成"只显示旧数字"，不弹错误打断学习
    }
  }, []);

  /** 整表重拉流水（发送完成、断线重连后调用） */
  const reload = useCallback(async () => {
    const r = await coachApi.messages();
    setCards(r.cards);
    setSnapshot(r.snapshot);
  }, []);

  useEffect(() => {
    void reload().catch(() => undefined);
    void refreshState();
    const timer = setInterval(() => void refreshState(), STATE_POLL_MS);
    return () => clearInterval(timer);
  }, [reload, refreshState]);

  // SSE：token 累积成临时卡，done 后整表重拉（服务端此刻已把这一轮落库）
  useEffect(() => {
    const client = connectSse(COACH_STREAM_URL, { reconcileUrl: COACH_LIVE_URL });
    const off = client.onEvent((ev) => {
      if (ev.type === 'token') {
        setStream((prev) => prev + ev.content);
      } else if (ev.type === 'done') {
        setStream('');
        setBusy(false);
        void reload().catch(() => undefined);
        void refreshState();
      } else if (ev.type === 'chat-error') {
        setError(ev.message);
        setBusy(false);
      }
    });
    return () => {
      off();
      client.close();
    };
  }, [reload, refreshState]);

  /** 打开抽屉：顺手催一次 + 拉队列。冷却在服务端把 —— 同一小时内反复开关也只会有一条提醒卡 */
  const openDrawer = useCallback(async () => {
    setOpen(true);
    try {
      const [n, q] = await Promise.all([coachApi.nudge(), api.terms.queue(QUEUE_LIMIT)]);
      if (n.card) setCards((prev) => mergeCards(prev, [n.card as CoachCard]));
      setQueue(q);
      void refreshState(); // 刚落过提醒卡 ⇒ 冷却生效，红点由服务端判定自动熄掉
    } catch {
      // 拉不到就先用旧数据把抽屉打开，别让人点不开
    }
  }, [refreshState]);

  const send = useCallback(async (text: string) => {
    setError('');
    setBusy(true);
    try {
      // 我的卡以服务端返回为准（它带着库里的真实时间与 id，重拉时才不会重复）
      const r = await coachApi.send(text);
      setCards((prev) => mergeCards(prev, [r.card]));
    } catch (e) {
      setError(e instanceof Error ? e.message : '发送失败');
      setBusy(false);
    }
  }, []);

  const review = useCallback(
    async (termId: string, remembered: boolean) => {
      if (busyTerm) return;
      setBusyTerm(termId);
      setError('');
      try {
        const r = await coachApi.review(termId, remembered);
        // 打卡后该条必然离开队列（记住→间隔推进；忘了→归零到明天），故本地直接摘掉
        setQueue((prev) => prev.filter((t) => t.id !== termId));
        setCards((prev) => mergeCards(prev, [r.card]));
        void refreshState(); // 胶囊数字要立刻跟着变（"真实的时间可以看到"）
      } catch (e) {
        setError(e instanceof Error ? e.message : '打卡失败');
      } finally {
        setBusyTerm(null);
      }
    },
    [busyTerm, refreshState],
  );

  const stop = useCallback(() => {
    void coachApi.abort().catch(() => undefined);
    setBusy(false);
  }, []);

  // 临时卡挂在末尾；文本为空则不插（空卡会渲染成一个空框）
  const visible = useMemo(() => withStreaming(cards, stream, new Date().toISOString()), [cards, stream]);

  return (
    <>
      <CoachCapsule
        snapshot={snapshot}
        open={open}
        nudge={nudge}
        onToggle={() => (open ? setOpen(false) : void openDrawer())}
      />
      {open && (
        <aside className="coach-drawer" aria-label="复习督促小窗">
          <header className="coach-drawer-head">
            <div>
              <div className="coach-drawer-title">复习督促</div>
              <div className="coach-drawer-sub">
                {snapshot
                  ? `${snapshot.due} 条待复习 · 逾期 ${snapshot.overdue} · 连续 ${snapshot.streak} 天 · 已记住 ${snapshot.mastered}`
                  : '正在读取欠账…'}
              </div>
            </div>
            <button className="coach-drawer-close" onClick={() => setOpen(false)} title="收起小窗">
              <MinusIcon size={15} />
            </button>
          </header>
          {error && <div className="coach-error">{error}</div>}
          <CoachFeed cards={visible} queue={queue} busyTerm={busyTerm} onReview={(id, r) => void review(id, r)} />
          <CoachComposer busy={busy} onSend={(t) => void send(t)} onStop={stop} />
        </aside>
      )}
    </>
  );
}
