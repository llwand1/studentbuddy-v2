/**
 * use-guide —— 引路灯的状态机（契约 `docs/GUIDE-SPEC.md` §8）：展开 / 收起、何时亮灯、首次自动展开、
 * 「先给规则、再换 AI」、用户手下不换。组件 `GuideBeacon` 只管渲染与键盘。
 *
 * ★ 阶段在前端也判一遍（`guideStage` 是 shared 的纯函数，用客户端知道的那部分现场）：亮灯要零成本、零等待，
 *   不能为了「该不该亮」去调模型。服务端会用更全的现场（词条欠账、有无模型）再判一次，两边共用同一份口径。
 * ★ 亮灯只在「刚发生了什么」的那一刻：聊完一轮（busy → chatted）、一组题刚变得可解析（能力里多了 quiz.explain）。
 *   光是打开一场有历史的会话不亮，讲解已经摆出来了也不再亮。离开被点亮的阶段就灭。
 * ★ 先给规则、再换 AI：点开立刻显示规则推荐；AI 回来原位替换。若用户此刻已把指针 / 焦点放在某一项上，
 *   不在他手下换——先挂起（`held`），由他点「有新建议 ↻」；收起再展开时自动用上。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  guideStage,
  guideTeaser,
  pomodoroFocus,
  ruleGuide,
  type GuideFacts,
  type GuideLang,
  type GuideNextResponse,
  type GuideReason,
  type GuideResult,
  type GuideStage,
  type GuideView,
} from '@sb/shared';
import { useGuideLive, type GuideLive } from './guide-store';
import { useGuideFetch, type GuideCtx } from './use-guide-fetch';
import { markGuideSeen, readGuideProactive, readGuideSeen, writeGuideProactive } from './guide-prefs';
import { usePomodoro } from '../pomodoro/pomodoro-store';

/** 首次自动展开的延迟：让页面先落定，别在首屏一出来就盖上去 */
export const GUIDE_AUTO_OPEN_MS = 1200;
/** 悬停多久算「想点」，才预取 AI 推荐 */
export const GUIDE_HOVER_PREFETCH_MS = 400;

const randomSeed = (): number => Math.floor(Math.random() * 100_000);

/** 客户端能知道的那部分现场（服务端才知道的词条欠账 / 有无模型先填中性值） */
export function clientFacts(lang: GuideLang, view: GuideView, live: GuideLive, focus: GuideFacts['focus'] = null): GuideFacts {
  const c = live.chat;
  return {
    lang,
    view,
    can: live.kinds,
    busy: !!c?.busy,
    hasModel: true,
    chat: c ? { rounds: c.rounds, lastUser: '', lastAssistant: '', quizzes: 0 } : null,
    terms: { total: 0, due: 0, overdue: 0, streak: 0 },
    sessions: 0,
    // 番茄钟方向（POMODORO-SPEC §5.4）：客户端也知道，规则推荐那几百毫秒里话题就已经落在方向里
    focus,
  };
}

/** 番茄钟刚开 / 刚进下一轮时提灯亮起的那句话 */
export function focusTeaser(subject: string, lang: GuideLang): string {
  return lang === 'zh' ? `专注「${subject}」，从这开始？` : `Focus on "${subject}" — start here?`;
}

export type GuideSource = 'ai' | 'rules' | 'loading';

export function useGuide({ lang, view, sessionId }: { lang: GuideLang; view: GuideView; sessionId: string | null }) {
  const live = useGuideLive();
  const pomo = usePomodoro().session;
  // 方向按「方向 + 轮次」记忆化：倒计时每秒变，不该让 facts 每秒重建
  const focusKey = pomo && pomo.phase === 'work' ? `${pomo.subject}|${pomo.round}` : '';
  const focus = useMemo(() => pomodoroFocus(pomo, new Date()), [focusKey]);
  const facts = useMemo(() => clientFacts(lang, view, live, focus), [lang, view, live, focus]);
  const stage = guideStage(facts);
  const ctx = useMemo<GuideCtx>(
    () => ({ lang, view, sessionId: view === 'chat' ? sessionId : null, can: live.kinds, busy: !!live.chat?.busy, rounds: live.chat?.rounds ?? 0 }),
    [lang, view, sessionId, live],
  );
  const f = useGuideFetch(ctx);
  const [open, setOpen] = useState(false);
  const [proactive, setProactiveState] = useState(readGuideProactive);
  const [litStage, setLitStage] = useState<GuideStage | null>(null);
  const [seed, setSeed] = useState(randomSeed);
  const [shown, setShown] = useState<{ key: string; res: GuideNextResponse } | null>(null);
  const [held, setHeld] = useState<{ key: string; res: GuideNextResponse } | null>(null);
  /** 用户展开后是否已经把指针 / 焦点放到某一项上（放上去了就不在他手下换列表） */
  const touched = useRef(false);

  // ── 展开 / 收起 ──
  const openPanel = useCallback(() => {
    touched.current = false;
    setHeld(null);
    setSeed(randomSeed());
    setLitStage(null);
    markGuideSeen();
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => (open ? close() : openPanel()), [open, close, openPanel]);
  /** 点完某一项：收起并灭灯 */
  const done = useCallback(() => {
    setOpen(false);
    setLitStage(null);
  }, []);

  // 展开期间，现场一变（又聊了一轮 / 题做完了）就重新要；展开瞬间也走这里
  useEffect(() => {
    if (open) f.load();
  }, [open, f.key, f.load]);

  // ── 先给规则、再换 AI ──
  useEffect(() => {
    const r = f.res;
    if (!r) return;
    if (open && touched.current) setHeld({ key: f.key, res: r });
    else {
      setShown({ key: f.key, res: r });
      setHeld(null);
    }
  }, [f.res, f.key, open]);
  const applyHeld = useCallback(() => {
    if (!held) return;
    setShown(held);
    setHeld(null);
    touched.current = false;
  }, [held]);
  const refresh = useCallback(() => {
    touched.current = false;
    setSeed(randomSeed());
    f.load(true);
  }, [f.load]);

  // ── 何时亮灯 ──
  // ★ 「做完题」的触发条件是「一组题**刚变得可解析**」（能力里多了 quiz.explain），而不是「进入 quizzed 阶段」：
  //   讲解生成期间两个题卡能力会暂时注销、阶段退回 chatted，生成完「再练一遍」重新登记又回到 quizzed——
  //   若按阶段触发，讲解明明已经摆在眼前，灯还会再亮一次「看解析」。
  const explainable = live.kinds.includes('quiz.explain');
  const prevStage = useRef<GuideStage | null>(null);
  const prevExplainable = useRef(false);
  useEffect(() => {
    const prev = prevStage.current;
    const wasExplainable = prevExplainable.current;
    prevStage.current = stage;
    prevExplainable.current = explainable;
    if (!proactive) {
      setLitStage(null);
      return;
    }
    if (stage === 'chatted' && prev === 'busy') setLitStage('chatted');
    else if (stage === 'quizzed' && explainable && !wasExplainable) setLitStage('quizzed');
    else if (stage !== litStage) setLitStage(null);
    // litStage 只用来判断「是否已经离开被点亮的阶段」，不作触发条件
  }, [stage, explainable, proactive]);

  // ── 番茄钟刚开 / 进下一轮 ⇒ 亮灯（POMODORO-SPEC §9）：此刻最该做的就是「从方向里开始」 ──
  const litByFocus = useRef(false);
  const prevFocusKey = useRef(focusKey);
  useEffect(() => {
    const was = prevFocusKey.current;
    prevFocusKey.current = focusKey;
    if (!proactive || !focusKey || focusKey === was) return;
    if (stage === 'fresh' || stage === 'chatted' || stage === 'tour') {
      litByFocus.current = true;
      setLitStage(stage);
    }
  }, [focusKey, proactive, stage]);
  useEffect(() => {
    if (!litStage) litByFocus.current = false;
  }, [litStage]);

  // ── 首次自动展开（本机仅一次；窄屏不盖，只靠点亮） ──
  useEffect(() => {
    if (!proactive || view !== 'chat' || stage !== 'fresh' || readGuideSeen()) return;
    if (window.matchMedia?.('(max-width: 700px)').matches) return;
    // 定时器触发时再确认一次：这 1.2 秒里用户若已手动打开过（openPanel 会置 seen），就别再开一遍、换掉他眼前的话题
    const t = window.setTimeout(() => {
      if (!readGuideSeen()) openPanel();
    }, GUIDE_AUTO_OPEN_MS);
    return () => window.clearTimeout(t);
  }, [proactive, view, stage, openPanel]);

  const setProactive = useCallback((on: boolean) => {
    writeGuideProactive(on);
    setProactiveState(on);
  }, []);

  // ── 弹层要渲染的东西 ──
  const rules = useMemo<GuideResult>(() => ruleGuide(facts, seed), [facts, seed]);
  const current = shown && shown.key === f.key ? shown.res : null;
  const source: GuideSource = current ? current.mode : f.loading ? 'loading' : 'rules';
  const result: GuideResult = current ?? rules;
  const reason: GuideReason | 'failed' | undefined = current?.reason ?? (f.failed && !current ? 'failed' : undefined);

  return {
    live,
    stage,
    open,
    toggle,
    close,
    done,
    lit: litStage,
    teaser: litStage ? (litByFocus.current && focus ? focusTeaser(focus.subject, lang) : guideTeaser(litStage, lang)) : null,
    source,
    result,
    reason,
    held: held !== null && held.key === f.key,
    applyHeld,
    refresh,
    seed,
    /** 用户把指针 / 焦点放到了某一项上 */
    touch: () => {
      touched.current = true;
    },
    /** 悬停 / 聚焦预取（已有缓存或在途则什么都不做） */
    prefetch: () => f.load(),
    proactive,
    setProactive,
  };
}
