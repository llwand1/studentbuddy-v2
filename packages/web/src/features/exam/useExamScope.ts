/**
 * useExamScope — 应试模式当前生效的范围（前端只读一份，别在每个页面各查各的）。
 *
 * 为什么要有这个 hook：范围过滤发生在服务端，客户端拿到的空列表**不解释自己为什么空**。
 * 而「范围内还没有词条」与「你还没有词条」是两件事——前者要给引导，后者要给空库文案。
 * 说错的那一句会被读成"数据被删了"，这正是老板 2026-10-05 拍「空态页＋引导」要防的事故。
 *
 * ★ 一次进程内共享一份结果（模块级缓存 + 订阅者集合）：词条页、大陆、卡牌三处都要问同一件事，
 *   各发一次请求就会在三处拿到不一致的开关状态（改设置后先刷新的那页对、后刷的页错）。
 */
import { useEffect, useState } from 'react';
import type { ExamModeView } from '@sb/shared';
import { api } from '../../lib/api';

type Listener = (v: ExamModeView | null) => void;

let cached: ExamModeView | null = null;
let inflight: Promise<ExamModeView | null> | null = null;
let queuedRefresh: Promise<ExamModeView | null> | null = null;
const listeners = new Set<Listener>();

function publish(v: ExamModeView | null) {
  cached = v;
  for (const l of listeners) l(v);
}

/** 拉一次（并发调用共用同一个请求）；失败不缓存，下次挂载会再试 */
export function refreshExamScope(force = false): Promise<ExamModeView | null> {
  if (cached && !force) return Promise.resolve(cached);
  if (inflight) {
    if (!force) return inflight;
    // 工具保存可能赶上旧请求仍在途；旧结果不能吞掉这次强制刷新。
    return queuedRefresh ??= inflight.then(() => {
      queuedRefresh = null;
      return refreshExamScope(true);
    });
  }
  const p: Promise<ExamModeView | null> = (async () => {
    try {
      // ★ 取 `api.settings.examMode` 这件事本身就可能抛（调用方只 mock 了 `api.terms` 的组件测试
      //   里，`api.settings` 是 undefined）。读不到范围的后果是「不渲染应试空态、退回各页原文案」，
      //   不是把宿主组件一起崩掉——所以这里连属性访问一起包在 try 里，而不是只包 promise。
      const r = await api.settings.examMode();
      publish(r);
      return r as ExamModeView | null;
    } catch {
      return null;
    }
  })().finally(() => {
    inflight = null;
  });
  inflight = p;
  return p;
}

/** 设置页改完范围/开关后调用，让其余页面同步（不靠用户手动刷新） */
export function setExamScopeCached(v: ExamModeView | null): void {
  publish(v);
}

export interface ExamScopeState {
  /** 读到了且开着 */
  on: boolean;
  /** 范围一句话（`高考、考研＋2 个自填站`）；关着或没读到为空串 */
  summary: string;
  /** 生效域名数；0 且 on ⇒ 用户开了但没勾范围 */
  hosts: number;
  /** 范围内有站内直达端点的站名 */
  directSites: string[];
  loaded: boolean;
}

export function useExamScope(): ExamScopeState {
  const [v, setV] = useState<ExamModeView | null>(cached);
  useEffect(() => {
    const l: Listener = (next) => setV(next);
    listeners.add(l);
    if (cached === null) void refreshExamScope();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return {
    on: Boolean(v?.on),
    summary: v?.summary ?? '',
    hosts: v?.hosts.length ?? 0,
    directSites: v?.directSites ?? [],
    loaded: v !== null,
  };
}
