import { useEffect, useRef, useState } from 'react';
import type { OpenQuizRound, QuizDraftAnswer, QuizRound, QuizRoundEvent, QuizRoundResponse } from '@sb/shared';
import { QUIZ_REVIEW_ACTIVE, parseQuizDraft } from '@sb/shared';
import { quizRoundsApi } from '../../lib/api-quiz-rounds';

type CachedDraft = Pick<QuizRoundResponse, 'index' | 'revision' | 'draft' | 'thought'>;
const cacheKey = (id: string) => `sb-quiz-round:${id}`;
const equalInput = (a: CachedDraft, b: CachedDraft) => a.thought === b.thought && JSON.stringify(a.draft) === JSON.stringify(b.draft);
function cache(round: QuizRound): void {
  try { localStorage.setItem(cacheKey(round.id), JSON.stringify(round.responses.map(({ index, revision, draft, thought }) => ({ index, revision, draft, thought })))); } catch { /* Server autosave still reports its own status. */ }
}
function readCache(round: QuizRound): CachedDraft[] {
  try {
    const raw = localStorage.getItem(cacheKey(round.id));
    if (!raw || raw.length > 500000) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data) || data.length !== round.responses.length) return [];
    return data.filter((r: unknown): r is CachedDraft => !!r && typeof r === 'object' && 'index' in r && 'revision' in r && 'thought' in r && 'draft' in r
      && typeof r.index === 'number' && Number.isInteger(r.index) && !!round.questions[r.index] && typeof r.revision === 'number' && Number.isInteger(r.revision)
      && typeof r.thought === 'string' && r.thought.length <= 4000 && !!parseQuizDraft(r.draft, round.questions[r.index]!));
  } catch { return []; }
}
export function useQuizRound(input: OpenQuizRound, recordId?: string) {
  const sourceKey = recordId ? `record:${recordId}` : JSON.stringify(input);
  const [round, setRound] = useState<QuizRound | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState(false);
  const [streamError, setStreamError] = useState('');
  const [recovery, setRecovery] = useState<CachedDraft[]>([]);
  const current = useRef<QuizRound | null>(null);
  const dirty = useRef(new Set<number>());
  const saveTask = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);
  const epoch = useRef(0);
  const source = useRef(input); source.current = input;
  const publish = (next: QuizRound, replace = false) => {
    if (!replace && current.current?.id === next.id && current.current.revision > next.revision) return;
    current.current = next; if (live.current) setRound(next);
  };
  const open = async (signal?: AbortSignal) => {
    const scope = epoch.current;
    setError('');
    try {
      let next = recordId ? await quizRoundsApi.get(recordId) : await quizRoundsApi.open(source.current, signal);
      if (signal?.aborted || !live.current || scope !== epoch.current) return;
      dirty.current.clear();
      if (next.state === 'draft') {
        const saved = readCache(next), conflicts: CachedDraft[] = [];
        next = { ...next, responses: next.responses.map(r => {
          const old = saved.find(a => a.index === r.index);
          if (!old || equalInput(old, r)) return r;
          if (old.revision !== r.revision) { conflicts.push(old); return r; }
          dirty.current.add(r.index); return { ...r, draft: old.draft, thought: old.thought };
        }) };
        setRecovery(conflicts);
      }
      publish(next, true);
      if (dirty.current.size) scheduleSave();
    } catch (e) { if (!signal?.aborted && live.current) setError(e instanceof Error ? e.message : '练习记录没有读到，请重试。'); }
  };
  const flush = (): Promise<void> => {
    if (saveTask.current) return saveTask.current;
    if (!dirty.current.size || current.current?.state !== 'draft') return Promise.resolve();
    const scope = epoch.current;
    const task = (async () => {
      if (live.current) setSaving(true);
      try {
        while (scope === epoch.current && dirty.current.size && current.current?.state === 'draft') {
          const r = current.current, index = dirty.current.values().next().value as number;
          const response = r.responses[index]!;
          dirty.current.delete(index);
          try {
            const saved = await quizRoundsApi.save(r.id, { index, revision: response.revision, draft: response.draft, thought: response.thought });
            const now = current.current;
            if (scope !== epoch.current || !now || now.id !== r.id || now.state !== 'draft') continue;
            const next = { ...now, responses: now.responses.map(a => a.index === index ? { ...a, revision: saved.revision } : a) };
            publish(next); cache(next);
          } catch (e) { if (scope !== epoch.current) return; dirty.current.add(index); throw e; }
        }
        if (live.current) setError('');
      } catch (e) { if (live.current) setError(e instanceof Error ? e.message : '保存未成功，输入仍保留，可重试。'); throw e; }
      finally { if (live.current && scope === epoch.current) setSaving(false); }
    })();
    saveTask.current = task;
    void task.finally(() => { if (saveTask.current === task) saveTask.current = null; }).catch(() => undefined);
    return task;
  };
  function scheduleSave() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void flush().catch(() => undefined); }, 450);
  }
  const change = (index: number, draft: QuizDraftAnswer, thought: string) => {
    const r = current.current;
    if (!r || r.state !== 'draft' || r.latestId !== r.id) return;
    const next = { ...r, responses: r.responses.map(a => a.index === index ? { ...a, draft, thought } : a) };
    dirty.current.add(index); publish(next); cache(next); scheduleSave();
  };
  useEffect(() => {
    epoch.current++; live.current = true; const controller = new AbortController();
    dirty.current.clear(); saveTask.current = null; setSaving(false); setActing(false);
    current.current = null; setRound(null); setRecovery([]); void open(controller.signal);
    return () => { epoch.current++; live.current = false; controller.abort(); if (timer.current) clearTimeout(timer.current); };
  }, [sourceKey]);
  const busy = !!round?.responses.some(r => QUIZ_REVIEW_ACTIVE.includes(r.status));
  useEffect(() => {
    if (!round || round.state !== 'submitted' || !busy || typeof EventSource === 'undefined') return;
    const id = round.id, events = new EventSource(quizRoundsApi.events(id));
    events.onopen = () => setStreamError('');
    events.onmessage = event => {
      let data: QuizRoundEvent;
      try { data = JSON.parse(event.data) as QuizRoundEvent; } catch { return; }
      const r = current.current;
      if (!r || r.id !== id) return;
      if (data.type === 'round' && data.round?.id === id) publish(data.round);
      else if (data.type === 'delta' && data.roundId === id && data.revision > r.revision && typeof data.delta === 'string') {
        const response = r.responses[data.index];
        if (!response || response.generation !== data.generation) return;
        publish({ ...r, revision: data.revision, responses: r.responses.map(a => a.index === data.index ? { ...a, analysis: (a.analysis + data.delta).slice(0, 24000) } : a) });
      }
    };
    events.onerror = () => setStreamError('分析连接暂时中断，正在重连；已保存的作答与已完成的分析仍保留。');
    return () => events.close();
  }, [round?.id, round?.state, busy]);
  const action = async (fn: (r: QuizRound) => Promise<QuizRound>, flushFirst = false) => {
    if (!current.current || acting) return;
    const scope = epoch.current;
    setActing(true); setError('');
    try {
      if (flushFirst) await flush();
      if (scope !== epoch.current || !current.current) return;
      const next = await fn(current.current!);
      if (!live.current || scope !== epoch.current) return;
      dirty.current.clear(); publish(next, next.id !== current.current?.id);
      if (next.state === 'submitted') { try { localStorage.removeItem(cacheKey(next.id)); } catch { /* No effect on server history. */ } }
      setRecovery([]);
      return next;
    } catch (e) { if (live.current && scope === epoch.current) setError(e instanceof Error ? e.message : '操作未完成，请重试。'); }
    finally { if (live.current && scope === epoch.current) setActing(false); }
  };
  return { round, error, saving, acting, busy, streamError, recovery: recovery.length > 0, change, flush,
    reload: () => void open(), save: () => { if (dirty.current.size) void flush().catch(() => undefined); else void open(); },
    restore: () => { for (const old of recovery) change(old.index, old.draft, old.thought); setRecovery([]); },
    submit: () => action(r => quizRoundsApi.submit(r.id, r.responses.map(({ index, revision, draft, thought }) => ({ index, revision, draft, thought }))), true),
    next: () => action(r => quizRoundsApi.next(r.latestId)),
    previous: () => action(r => quizRoundsApi.get(r.previousId!), true),
    latest: () => action(r => quizRoundsApi.get(r.latestId), true),
    retry: (index: number) => action(r => quizRoundsApi.retry(r.id, index)),
    cancel: () => action(r => quizRoundsApi.cancel(r.id)),
  };
}
