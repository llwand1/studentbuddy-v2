/**
 * useDrillSession — 一局「等待时刷词」的状态机（契约 `docs/WAIT-DRILL-SPEC.md` §3）。
 *
 *   loading ──取词──▶ question ──答──▶ reveal ──下一张──▶ question …
 *                        │                 ▲
 *                        └── 新词先 learn ──┘        队列空 ⇒ empty（新词到了会自动续上）
 *
 * ★ 题面 / 判分 / 排队全走 `@sb/shared/drill`（与知识大陆同源的归一化与哈希）；本 hook 只管"下一张是谁、
 *   答完记什么账"。词条来自既有 `GET /api/terms/review/map`（全库 + 服务端现算的到期状态），一开局取一次。
 * ★ 三种来路三种账（用户选的口径）：
 *   - `due`（范围内到期 = 大陆上的怪）：答对 ⇒ `termsReviewApi.mark(id, true)` 一次真打卡（怪消失）；
 *   - `library`：只记本机战绩，不碰复习日程；
 *   - `new`（模型 / 词池出的新词）：先学再答，答对后「收入词库」/「不要」由用户定（候选闸门）。
 * ★ 答错的卡隔 `DRILL_REQUEUE_GAP` 张再来；「斩」= 今天不再出（本机记 id），不改任何服务端状态。
 * ★ 队列刷完就从头再排一轮（等待多久刷多久），斩掉的仍不出；库空且新词也没有 ⇒ `empty` 如实说明。
 * ★ 所有网络失败都进 `notice` 显示（ADR-5 禁静默），刷词本身不因打卡失败而卡住。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DRILL_REQUEUE_GAP,
  buildDrillCard,
  drillKindAt,
  gradeDrill,
  isComboMilestone,
  requeueIndex,
  type DrillCard,
  type DrillNewTerm,
  type DrillOrigin,
  type DrillQueueTerm,
  type DrillTermLike,
} from '@sb/shared';
import { termsContinentApi } from '../../lib/api-terms-continent';
import { termsReviewApi } from '../../lib/api-terms-review';
import { drillApi } from '../../lib/api-drill';
import type { DrillAudio } from './drill-audio';
import { fxKindFor, type DrillFxState } from './DrillFx';
import { loadDrillStats, saveDrillStats } from './drill-prefs';
import { buildDrillQueue, drillFocusNotice, needsFocusRefill } from './drill-focus';
import { readPomodoro } from '../pomodoro/pomodoro-store';

/** 方向内排空后「现场出题」最多补几次：补不到就如实说空，不无限打网络 */
const MAX_FOCUS_REFILL = 3;

export type DrillPhase = 'loading' | 'question' | 'reveal' | 'learn' | 'empty';

export interface DrillEntry {
  term: DrillTermLike;
  origin: DrillOrigin;
  newItem?: DrillNewTerm;
}

export interface DrillStats {
  correct: number;
  wrong: number;
  combo: number;
  bestCombo: number;
  slain: number;
  reviewed: number;
}

export interface DrillResult {
  correct: boolean;
  /** 选的下标 / 输入的文本；「不认识」与「斩」为 null */
  answer: number | string | null;
  /** 这张是被「斩」掉的（不是答出来的） */
  slain?: boolean;
}

/** 答对后自动翻下一张的停留（百词斩式"对了就闪过"，但要能看清绿色亮的是哪条） */
export const DRILL_ADVANCE_MS = 750;
/** 新词第一次见与词库卡之间隔几张 */
const NEW_TERM_GAP = 4;

const errText = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback);

export interface UseDrillSessionOptions {
  open: boolean;
  sessionId: string | null;
  dayKey: string;
  audio: DrillAudio | null;
  /** 一张卡走完（下一张之前）回调：等回复到了的那一刻，宿主借它决定"答完这张就切回去" */
  onCardResolved?: () => boolean | void;
}

export function useDrillSession({ open, sessionId, dayKey, audio, onCardResolved }: UseDrillSessionOptions) {
  const [phase, setPhase] = useState<DrillPhase>('loading');
  const [entry, setEntry] = useState<DrillEntry | null>(null);
  const [card, setCard] = useState<DrillCard | null>(null);
  const [result, setResult] = useState<DrillResult | null>(null);
  const [fx, setFx] = useState<DrillFxState | null>(null);
  const [notice, setNotice] = useState('');
  const [newNote, setNewNote] = useState('');
  const [stats, setStats] = useState<DrillStats>({ correct: 0, wrong: 0, combo: 0, bestCombo: 0, slain: 0, reviewed: 0 });
  const [queueLeft, setQueueLeft] = useState(0);
  /** 拼写卡打到一半的字（§2.1：收起再唤回不能丢，所以住在局里而不是卡组件里） */
  const [draft, setDraft] = useState('');

  const queue = useRef<DrillEntry[]>([]);
  const pool = useRef<DrillTermLike[]>([]);
  const library = useRef<readonly DrillQueueTerm[]>([]);
  const slain = useRef<Set<string>>(new Set());
  const served = useRef(0);
  const fxKey = useRef(0);
  const advance = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolvedRef = useRef(onCardResolved);
  resolvedRef.current = onCardResolved;
  const phaseRef = useRef<DrillPhase>('loading');
  phaseRef.current = phase;
  /** 开局时本机已有的当天战绩（落盘时叠加本局） */
  const dayBase = useRef({ correct: 0, reviewed: 0, bestCombo: 0 });
  /** 「现场出题」的闸：同一时刻只允许一次在飞，且本局最多补 `MAX_FOCUS_REFILL` 次（防排空→请求→仍空的死循环） */
  const refill = useRef({ inFlight: false, tries: 0 });
  /**
   * `requestNewTerms` 要在新词到达后续上一张、`serve` 又要在排空时叫它——两个 ref 打断这对循环依赖。
   * ★ `serve` **绝不能**把 `requestNewTerms`（含 `sessionId`）写进 deps：开局 effect 依赖 `serve`，
   *   一旦 `serve` 随会话变身份，换会话就会重开局，踩掉「换会话只补新词、不重开局」（WAIT-DRILL-SPEC §2.1）。
   */
  const serveRef = useRef<() => void>(() => undefined);
  const requestNewTermsRef = useRef<(reason: 'open' | 'focus') => void>(() => undefined);

  const clearAdvance = () => {
    if (advance.current) clearTimeout(advance.current);
    advance.current = null;
  };

  /**
   * 新词到了：第一条排成**下一张**（正在答的那张是词库的，已经进入节奏），之后每隔 `NEW_TERM_GAP` 张一条；
   * 正在 empty 就立刻续上。
   */
  const injectNew = useCallback(
    (items: DrillNewTerm[]) => {
      const entries: DrillEntry[] = items.map((it) => ({
        term: { id: `new:${it.candidateId ?? it.term}`, term: it.term, definition: it.definition, domain: it.domain },
        origin: 'new',
        newItem: it,
      }));
      entries.forEach((e, i) => {
        const at = Math.min(queue.current.length, i * NEW_TERM_GAP);
        queue.current.splice(at, 0, e);
      });
      setQueueLeft(queue.current.length);
    },
    [],
  );

  /**
   * 要一批新词。`open` 是开局那次（原行为）；`focus` 是番茄钟方向内排空后的**现场出题**，
   * 后者带闸：同一时刻只一次在飞、本局最多 `MAX_FOCUS_REFILL` 次——补不到就如实说空，不无限打网络。
   */
  const requestNewTerms = useCallback(
    (reason: 'open' | 'focus') => {
      if (reason === 'focus') {
        if (refill.current.inFlight || refill.current.tries >= MAX_FOCUS_REFILL) return;
        refill.current.inFlight = true;
        refill.current.tries += 1;
      }
      void drillApi
        .newTerms(sessionId)
        .then((r) => {
          if (r.fallbackReason) setNewNote(r.fallbackReason);
          if (r.items.length > 0) {
            injectNew(r.items);
            if (phaseRef.current === 'empty') serveRef.current();
          }
        })
        .catch((e: unknown) => setNewNote(errText(e, '这次没要到新词')))
        .finally(() => {
          if (reason === 'focus') refill.current.inFlight = false;
        });
    },
    [sessionId, injectNew],
  );
  requestNewTermsRef.current = requestNewTerms;

  /** 从队列里拿下一张；空了就重排一轮词库；仍空 ⇒ empty */
  const serve = useCallback(() => {
    clearAdvance();
    setResult(null);
    setDraft('');
    if (queue.current.length === 0) {
      // 番茄钟方向（POMODORO-SPEC §5.3）：工作段**硬过滤**——方向外的词条不进队列；
      // 方向内排空后按 drill-focus 的三级兜底（重复巩固 → 现场出题 → 如实说空）。
      const pomo = readPomodoro().session;
      const subject = pomo && pomo.phase === 'work' ? pomo.subject : null;
      const built = buildDrillQueue({ terms: library.current, dayKey: `${dayKey}|r${served.current}`, exclude: slain.current, subject });
      queue.current = built.items.map((q) => ({ term: q.term, origin: q.origin }));
      const line = drillFocusNotice(built.outcome, subject);
      if (line) setNotice(line);
      if (needsFocusRefill(built.outcome)) requestNewTermsRef.current('focus');
    }
    const nextEntry = queue.current.shift() ?? null;
    setQueueLeft(queue.current.length);
    if (!nextEntry) {
      setEntry(null);
      setCard(null);
      setPhase('empty');
      return;
    }
    const kind = nextEntry.origin === 'new' ? 'meaning' : drillKindAt(served.current, dayKey);
    served.current += 1;
    setEntry(nextEntry);
    setCard(buildDrillCard(kind, nextEntry.term, pool.current, nextEntry.origin, `${dayKey}|${served.current}`));
    setPhase(nextEntry.origin === 'new' ? 'learn' : 'question');
    if (nextEntry.origin === 'new') audio?.play('new');
  }, [dayKey, audio]);
  serveRef.current = serve;

  // 开局：取词。★ `open` 在这里的语义是"这一局在跑"，不是"小窗看得见"——小窗收起再唤回（§2.1）不走这里，
  //   队列 / 连击 / 本局战绩原样接着；只有真正结束（小签 ✕）或下一次开局才重来。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const day = loadDrillStats(dayKey);
    slain.current = new Set(day.slain);
    dayBase.current = { correct: day.correct, reviewed: day.reviewed, bestCombo: day.bestCombo };
    setStats({ correct: 0, wrong: 0, combo: 0, bestCombo: day.bestCombo, slain: day.slain.length, reviewed: 0 });
    setNotice('');
    setNewNote('');
    setFx(null);
    served.current = 0;
    queue.current = [];
    setPhase('loading');
    void termsContinentApi
      .map()
      .then((m) => {
        if (!alive) return;
        library.current = m.terms.map((t) => ({
          id: t.id,
          term: t.term,
          definition: t.definition,
          domain: t.domain,
          status: t.review.status,
          inScope: t.review_in_scope === 1,
        }));
        pool.current = library.current.map((t) => ({ id: t.id, term: t.term, definition: t.definition, domain: t.domain }));
        serve();
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setNotice(errText(e, '词库没取到'));
        setPhase('empty');
      });
    return () => {
      alive = false;
      clearAdvance();
    };
  }, [open, dayKey, serve]);

  // 要新词：开局要一次；局中换了正在等的会话（新话题）再要一次插进队列——新词跟着话题走，唤回的局也不例外。
  // 换会话 ⇒ 现场出题的次数闸重新计数（新话题值得重新给它三次机会）。
  useEffect(() => {
    if (!open) return;
    refill.current = { inFlight: false, tries: 0 };
    requestNewTerms('open');
  }, [open, sessionId, requestNewTerms]);

  // 当天战绩落本机（本局数字叠在开局时读到的底数上）
  useEffect(() => {
    if (!open || phase === 'loading') return;
    saveDrillStats({
      day: dayKey,
      slain: [...slain.current],
      correct: dayBase.current.correct + stats.correct,
      bestCombo: Math.max(dayBase.current.bestCombo, stats.bestCombo),
      reviewed: dayBase.current.reviewed + stats.reviewed,
    });
  }, [open, phase, dayKey, stats.correct, stats.bestCombo, stats.slain, stats.reviewed]);

  const finishCard = useCallback(() => {
    if (resolvedRef.current?.() === true) return; // 宿主接管（切回对话）
    serve();
  }, [serve]);

  const next = useCallback(() => {
    if (phase !== 'reveal' && phase !== 'learn') return;
    audio?.play('flip');
    finishCard();
  }, [phase, audio, finishCard]);

  const learned = useCallback(() => {
    if (phase !== 'learn') return;
    audio?.play('flip');
    setPhase('question');
  }, [phase, audio]);

  const answer = useCallback(
    (a: number | string | null) => {
      if (phase !== 'question' || !card || !entry) return;
      const ok = a !== null && gradeDrill(card, a, entry.term.aliases ?? []);
      setResult({ correct: ok, answer: a });
      setPhase('reveal');
      fxKey.current += 1;
      if (ok) {
        const combo = stats.combo + 1;
        const milestone = isComboMilestone(combo);
        setStats((s) => ({ ...s, correct: s.correct + 1, combo, bestCombo: Math.max(s.bestCombo, combo) }));
        setFx({ kind: fxKindFor(stats.correct + 1), key: fxKey.current, combo: milestone ? combo : undefined });
        audio?.play(milestone ? 'combo' : 'correct');
        if (entry.origin === 'due') {
          void termsReviewApi
            .mark(entry.term.id, true)
            .then(() => {
              setStats((s) => ({ ...s, reviewed: s.reviewed + 1 }));
              setNotice(`「${entry.term.term}」已打卡——大陆上那只怪消失了`);
            })
            .catch((e: unknown) => setNotice(`「${entry.term.term}」打卡没成：${errText(e, '稍后到大陆再打一次')}`));
        }
        if (entry.origin !== 'new') advance.current = setTimeout(finishCard, DRILL_ADVANCE_MS);
      } else {
        setStats((s) => ({ ...s, wrong: s.wrong + 1, combo: 0 }));
        setFx({ kind: 'wrong', key: fxKey.current });
        audio?.play('wrong');
        if (entry.origin !== 'new') queue.current.splice(requeueIndex(queue.current.length, DRILL_REQUEUE_GAP), 0, entry);
        setQueueLeft(queue.current.length);
      }
    },
    [phase, card, entry, stats.combo, stats.correct, audio, finishCard],
  );

  const dontKnow = useCallback(() => answer(null), [answer]);

  /** 斩：今天不再出这条（本机记 id）；新词没有"斩"（它还不在库里） */
  const slay = useCallback(() => {
    if (!entry || entry.origin === 'new' || phase === 'loading' || phase === 'empty') return;
    clearAdvance();
    slain.current.add(entry.term.id);
    queue.current = queue.current.filter((q) => q.term.id !== entry.term.id);
    setStats((s) => ({ ...s, slain: s.slain + 1 }));
    fxKey.current += 1;
    setFx({ kind: 'slash', key: fxKey.current });
    audio?.play('slash');
    setPhase('reveal');
    setResult({ correct: true, answer: null, slain: true });
    advance.current = setTimeout(finishCard, 520);
  }, [entry, phase, audio, finishCard]);

  /** 新词：收入词库 */
  const keep = useCallback(() => {
    const it = entry?.newItem;
    if (!it || phase !== 'reveal') return;
    void drillApi
      .keep(it)
      .then((r) => {
        setNotice(`「${r.term}」已收入词库${it.source === 'fallback' ? '（来自内置词池）' : ''}`);
        finishCard();
      })
      .catch((e: unknown) => setNotice(`收入词库没成：${errText(e, '稍后再试')}`));
  }, [entry, phase, finishCard]);

  /** 新词：不要（候选标驳回；词池条目直接翻过） */
  const dismiss = useCallback(() => {
    const it = entry?.newItem;
    if (!it || phase !== 'reveal') return;
    if (it.candidateId) void drillApi.dismiss(it.candidateId).catch(() => undefined);
    finishCard();
  }, [entry, phase, finishCard]);

  return { phase, entry, card, result, fx, notice, newNote, stats, queueLeft, draft, setDraft, answer, dontKnow, next, learned, slay, keep, dismiss };
}
