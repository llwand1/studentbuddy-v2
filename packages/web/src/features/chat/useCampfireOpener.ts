import { useEffect, useRef, useState } from 'react';
import { INTERACTIVE_AI_BUDGET, normalizeCampfireQuestion, OPENER_HISTORY_LIMIT, type CampfireOpener } from '@sb/shared';
import { api } from '../../lib/api';

type Result = { key: string; status: 'loading' | 'ready' | 'error'; value?: CampfireOpener; error?: string };
export function useCampfireOpener(scopeKey: string, enabled: boolean, frozen = false) {
  /** 仅当前挂载的题干排重，账号之间不共享内容；跨刷新由服务端的归属摘要守。 */
  const recent = useRef<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  const key = `${scopeKey}\u0000${attempt}`;
  const [result, setResult] = useState<Result>({ key, status: 'loading' });
  useEffect(() => {
    if (!enabled) { if (!frozen) setResult({ key, status: 'loading' }); return; }
    let alive = true;
    const controller = new AbortController();
    setResult({ key, status: 'loading' });
    // 短合并窗口：StrictMode 的试挂载不外呼，范围首次载入也不重复召题。
    const timer = window.setTimeout(() => {
      const exclude = [...recent.current];
      void api.request<CampfireOpener>('/api/chat/opener', {
        method: 'POST', body: JSON.stringify({ exclude }), cache: 'no-store', signal: controller.signal, timeoutMs: INTERACTIVE_AI_BUDGET.clientMs,
      }).then(value => {
        if (!alive || controller.signal.aborted) return;
        const question = normalizeCampfireQuestion(value.question, exclude);
        if (!question || typeof value.id !== 'string' || !value.id) throw new Error('这次没能召出合格的新题，请重试。');
        recent.current.push(question.question);
        recent.current.splice(0, Math.max(0, recent.current.length - OPENER_HISTORY_LIMIT));
        setResult({ key, status: 'ready', value: { id: value.id, question, scope: typeof value.scope === 'string' ? value.scope : '' } });
      }).catch(error => {
        if (!alive || controller.signal.aborted) return;
        setResult({ key, status: 'error', error: error instanceof Error ? error.message : '召题暂时失败，请重试。' });
      });
    }, 100);
    return () => { alive = false; window.clearTimeout(timer); controller.abort(); };
  }, [key, enabled, frozen]);
  // render 阶段就隔离旧结果，不能等 effect 清掉上一范围的题再渲染。
  const current = (enabled || frozen) && result.key === key ? result : { key, status: 'loading' as const };
  return { ...current, retry: () => setAttempt(value => value + 1) };
}
