/**
 * guide-store —— 引路灯的三样共享状态，一个微型外部 store（与 `lib/preview-store.ts` 同手法：
 * 模块级状态 + `useSyncExternalStore`，省掉 provider 穿层，也便于单测）。契约 `docs/GUIDE-SPEC.md` §3 / §8。
 *
 * ① **能力注册表**：各组件声明「此刻我能做 X」并交出处理器（`registerGuideCap`）。
 *    「一键解析」要用题卡里的作答状态、「存入记忆」要用对话消息——它们活在各自组件里，提灯不越界去抓，
 *    而是让组件自己报名。组件卸载 / 状态变化、能力自动消失 ⇒ 推荐只会落在真能点的动作上。
 *    同一种动作可以有多个登记者（一个会话里有好几张题卡）：**最近登记的那个生效**。
 * ② **对话现场**：ChatView 上报「哪个会话、几轮、空不空、忙不忙」，提灯据此判阶段、决定何时亮灯。
 * ③ **话题信箱**：`chat.topic` 要在「未选会话」态下开新会话再发话，提灯与 ChatView 不在同一棵子树上——
 *    提灯把话放进信箱、请 App 切到未选会话态，ChatView 取信走既有的 `useQuickStart.fire`（不另造发送路径）。
 *    ★ 条目 5 秒过期：避免过期话题在之后某次「删掉当前会话」时被莫名发出。
 *
 * ★ 快照必须引用稳定（没变就返回同一个对象），否则 `useSyncExternalStore` 会死循环；
 *   所以 `publish` 先比一遍，什么都没变就不通知——组件每次渲染都重新登记处理器的写法因此不会引起抖动。
 */
import { useSyncExternalStore } from 'react';
import { GUIDE_KINDS, type GuideKind } from '@sb/shared';

/** 动作处理器；只有 `chat.topic` / `chat.ask` 会带文本 */
export type GuideHandler = (text?: string) => void;

export interface GuideChatLive {
  sessionId: string | null;
  rounds: number;
  /** 会话里什么都没有（空白会话 / 还没选会话） */
  empty: boolean;
  /** 不能动：正在生成 / 正在开会话 / 连接还没就绪 */
  busy: boolean;
}

export interface GuideLive {
  /** 此刻有人登记了处理器的动作种类（按白名单顺序，稳定） */
  kinds: readonly GuideKind[];
  chat: GuideChatLive | null;
  /** 信箱里待发的话题（已过期的在 `takeGuideMail` 时才被丢掉） */
  mail: string | null;
}

export const GUIDE_MAIL_TTL_MS = 5000;

interface Entry {
  id: number;
  fn: GuideHandler;
}

const caps = new Map<GuideKind, Entry[]>();
let seq = 0;
let chat: GuideChatLive | null = null;
let mail: { text: string; at: number } | null = null;
let snap: GuideLive = { kinds: [], chat: null, mail: null };
const listeners = new Set<() => void>();

const sameKinds = (a: readonly GuideKind[], b: readonly GuideKind[]): boolean => a.length === b.length && a.every((k, i) => k === b[i]);
const sameChat = (a: GuideChatLive | null, b: GuideChatLive | null): boolean =>
  a === b || (!!a && !!b && a.sessionId === b.sessionId && a.rounds === b.rounds && a.empty === b.empty && a.busy === b.busy);

function publish(): void {
  const kinds = GUIDE_KINDS.filter((k) => (caps.get(k)?.length ?? 0) > 0);
  const next: GuideLive = { kinds: sameKinds(snap.kinds, kinds) ? snap.kinds : kinds, chat, mail: mail?.text ?? null };
  if (next.kinds === snap.kinds && next.chat === snap.chat && next.mail === snap.mail) return;
  snap = next;
  for (const l of [...listeners]) l();
}

export function subscribeGuide(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getGuideLive(): GuideLive {
  return snap;
}

export function useGuideLive(): GuideLive {
  return useSyncExternalStore(subscribeGuide, getGuideLive, getGuideLive);
}

/** 登记一个动作的处理器；返回注销函数（组件卸载 / 能力失效时调用） */
export function registerGuideCap(kind: GuideKind, fn: GuideHandler): () => void {
  const entry: Entry = { id: ++seq, fn };
  caps.set(kind, [...(caps.get(kind) ?? []), entry]);
  publish();
  return () => {
    const rest = (caps.get(kind) ?? []).filter((e) => e.id !== entry.id);
    if (rest.length > 0) caps.set(kind, rest);
    else caps.delete(kind);
    publish();
  };
}

/** 执行某种动作：交给最近登记的处理器；没人登记 ⇒ false（调用方如实告诉用户「现在做不了」） */
export function runGuideCap(kind: GuideKind, text?: string): boolean {
  const list = caps.get(kind);
  const top = list?.[list.length - 1];
  if (!top) return false;
  top.fn(text);
  return true;
}

/** ChatView 上报 / 撤销对话现场（内容没变不通知） */
export function setGuideChat(next: GuideChatLive | null): void {
  if (sameChat(chat, next)) return;
  chat = next;
  publish();
}

export function getGuideChat(): GuideChatLive | null {
  return chat;
}

export function putGuideMail(text: string, now: number = Date.now()): void {
  mail = { text, at: now };
  publish();
}

/** 取走信箱里的话；过期的当没有（并清掉） */
export function takeGuideMail(now: number = Date.now()): string | null {
  const m = mail;
  mail = null;
  publish();
  return m && now - m.at <= GUIDE_MAIL_TTL_MS ? m.text : null;
}

/** 测试用：回到出厂状态 */
export function resetGuideStore(): void {
  caps.clear();
  chat = null;
  mail = null;
  publish();
}
