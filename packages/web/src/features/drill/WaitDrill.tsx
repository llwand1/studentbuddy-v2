/**
 * WaitDrill — 「等待时刷词」的宿主（挂在 App 壳层，与 `CoachDock` 同层常驻）。
 *
 * 把三件事拼起来（契约 `docs/WAIT-DRILL-SPEC.md` §2–§3）：
 *   - `useDrillTrigger`：桌面发送后 2 秒还没回完 ⇒ 弹；手机仅手动开；回复到了 ⇒ `replyReady`。
 *   - `useDrillSession`：一局的状态机（取词 / 出卡 / 判分 / 记账 / 新词）。
 *   - `DrillAudio`：弹窗开着就放配乐，关了就停；音效由状态机按事件触发。
 * ★ 切回时机：**答完这张**再切（`onCardResolved` 返回 true 表示宿主接管）；回复到了却一直不答，
 *   `READY_GRACE_S` 秒后也切（等待的意义已经没了）。「继续刷」按下后本轮不再自动切。
 * ★ 偏好（自动弹 / 声音）来自本机 `drill-prefs`；设置页改了会发 `sb:drill-prefs`，这里跟着刷新。
 * ★ 等待气泡里的「刷词」入口发 `sb:drill-open`（跨组件不传 props，ChatView 贴着行数红线）。
 * ★ 收起 ≠ 结束（§2.1，2026-09-30）：`alive`（这一局在跑）与 `trigger.open`（小窗看得见）分开——✕ / Esc / 回复到了
 *   自动切回只把小窗收起，队列与连击留着，`drill-dock` 里写一份「已收起 · 还有 N 张」给输入框上方的小签；
 *   小签点一下 = `sb:drill-open` 原局唤回，小签 ✕ = `sb:drill-end` 才真正结束。下一轮等待自动弹的也是这同一局。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { localDayKey } from '@sb/shared';
import { useNarrow } from '../../lib/use-narrow';
import { useMobilePanel } from '../../lib/use-mobile-panel';
import { DrillAudio } from './drill-audio';
import { DrillOverlay } from './DrillOverlay';
import { DRILL_END_EVENT, resetDrillDock, setDrillDock } from './drill-dock';
import { DRILL_OPEN_EVENT, DRILL_PREFS_EVENT, loadDrillPrefs, saveDrillPrefs } from './drill-prefs';
import { useDrillKeys } from './useDrillKeys';
import { useDrillSession } from './useDrillSession';
import { useDrillTrigger } from './useDrillTrigger';

/** 回复到了之后最多再等几秒（不答也切回去） */
export const READY_GRACE_S = 8;

export function WaitDrill({ busySessionId, active }: { busySessionId: string | null; active: boolean }) {
  const narrow = useNarrow();
  const [prefs, setPrefs] = useState(loadDrillPrefs);
  useEffect(() => {
    const sync = () => setPrefs(loadDrillPrefs());
    window.addEventListener(DRILL_PREFS_EVENT, sync);
    return () => window.removeEventListener(DRILL_PREFS_EVENT, sync);
  }, []);

  const trigger = useDrillTrigger({ busySessionId, active: active && !narrow, enabled: prefs.enabled });
  useMobilePanel(trigger.open, trigger.close);
  const { openNow } = trigger;
  useEffect(() => {
    const onOpen = () => openNow();
    window.addEventListener(DRILL_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(DRILL_OPEN_EVENT, onOpen);
  }, [openNow]);

  const audio = useMemo(() => new DrillAudio(undefined, !loadDrillPrefs().sound), []);
  useEffect(() => () => audio.dispose(), [audio]);
  useEffect(() => {
    if (trigger.open) audio.start();
    else audio.stop();
  }, [trigger.open, audio]);
  useEffect(() => {
    audio.setMuted(!prefs.sound);
  }, [prefs.sound, audio]);

  const dayKey = useMemo(() => localDayKey(new Date()), []);
  const [stay, setStay] = useState(false);
  const [countdown, setCountdown] = useState(READY_GRACE_S);
  const leaveRef = useRef(false);
  leaveRef.current = trigger.replyReady && !stay;

  const { close } = trigger;
  const leave = useCallback(() => {
    setStay(false);
    close();
  }, [close]);

  const onCardResolved = useCallback((): boolean => {
    if (!leaveRef.current) return false;
    leave();
    return true;
  }, [leave]);

  // 这一局在跑（小窗开过一次就算开局；收起不算结束）
  const [alive, setAlive] = useState(false);
  useEffect(() => {
    if (trigger.open) setAlive(true);
  }, [trigger.open]);
  useEffect(() => {
    const onEnd = () => {
      setAlive(false);
      leave();
    };
    window.addEventListener(DRILL_END_EVENT, onEnd);
    return () => window.removeEventListener(DRILL_END_EVENT, onEnd);
  }, [leave]);

  const s = useDrillSession({ open: alive, sessionId: trigger.openSession, dayKey, audio, onCardResolved });

  // 给输入框上方的小签：收起了才 parked；数字随局走
  useEffect(() => {
    setDrillDock({ parked: alive && !trigger.open, queueLeft: s.queueLeft, correct: s.stats.correct, combo: s.stats.combo });
  }, [alive, trigger.open, s.queueLeft, s.stats.correct, s.stats.combo]);
  useEffect(() => () => resetDrillDock(), []);

  // 回复到了：一声提示音 + 倒计时；到点不答也切
  useEffect(() => {
    if (!trigger.open || !trigger.replyReady || stay) return;
    audio.play('ready');
    setCountdown(READY_GRACE_S);
    const t0 = Date.now();
    const timer = setInterval(() => {
      const left = READY_GRACE_S - Math.floor((Date.now() - t0) / 1000);
      setCountdown(Math.max(0, left));
      if (left <= 0) {
        clearInterval(timer);
        leave();
      }
    }, 250);
    return () => clearInterval(timer);
  }, [trigger.open, trigger.replyReady, stay, audio, leave]);

  // 没在答题（空 / 取词中）时回复到了 ⇒ 直接回
  useEffect(() => {
    if (trigger.replyReady && !stay && (s.phase === 'empty' || s.phase === 'loading')) leave();
  }, [trigger.replyReady, stay, s.phase, leave]);

  useEffect(() => {
    if (!trigger.open) setStay(false);
  }, [trigger.open]);

  const toggleSound = useCallback(() => {
    const next = saveDrillPrefs({ sound: !prefs.sound });
    setPrefs(next);
    audio.setMuted(!next.sound);
    if (next.sound) audio.resume();
  }, [prefs.sound, audio]);

  const onEnter = useCallback(() => {
    if (s.phase === 'learn') s.learned();
    else if (s.phase === 'reveal') {
      if (s.entry?.origin === 'new') s.keep();
      else s.next();
    }
  }, [s]);

  useDrillKeys(trigger.open, {
    onDigit: (i) => {
      audio.resume();
      s.answer(i);
    },
    onEnter,
    onDontKnow: s.dontKnow,
    onSlay: s.slay,
    onDismiss: s.dismiss,
    onClose: leave,
  });

  if (!trigger.open) return null;
  return (
    <DrillOverlay
      busy={busySessionId !== null}
      practice={busySessionId === null && !trigger.replyReady}
      replyReady={trigger.replyReady && !stay}
      readyCountdown={countdown}
      muted={!prefs.sound}
      phase={s.phase}
      card={s.card}
      entry={s.entry}
      result={s.result}
      fx={s.fx}
      stats={s.stats}
      queueLeft={s.queueLeft}
      notice={s.notice}
      newNote={s.newNote}
      keepState={s.keepState}
      draft={s.draft}
      onDraft={s.setDraft}
      onToggleSound={toggleSound}
      onClose={leave}
      onLeaveNow={leave}
      onStay={() => setStay(true)}
      onAnswer={(a) => {
        audio.resume();
        s.answer(a);
      }}
      onDontKnow={s.dontKnow}
      onNext={s.next}
      onLearned={s.learned}
      onSlay={s.slay}
      onKeep={s.keep}
      onDismiss={s.dismiss}
      windowPos={prefs.pos ?? null}
      onWindowMoved={(pos) => setPrefs(saveDrillPrefs({ pos }))}
    />
  );
}
