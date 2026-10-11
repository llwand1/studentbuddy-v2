import { useEffect, useRef, useState } from 'react';
import type { QuizFeedbackChoices, QuizFeedbackOption, QuizFeedbackRequest, QuizFeedbackResult } from '@sb/shared';
import { request } from '../../lib/api-request';

export function useQuestionFeedback(input: QuizFeedbackRequest, onAdapted?: (result: QuizFeedbackResult) => void) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<QuizFeedbackOption[]>([]);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState<'choices' | 'adapt' | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<QuizFeedbackResult | null>(null);
  const controller = useRef<AbortController | null>(null);
  const identity = `${input.sessionId ?? ''}:${JSON.stringify(input.question)}`;
  useEffect(() => {
    setOpen(false); setOptions([]); setCustom(''); setBusy(null); setError(''); setResult(null);
    return () => { controller.current?.abort(); controller.current = null; };
  }, [identity]);

  const cancel = () => { controller.current?.abort(); controller.current = null; setBusy(null); };
  const predict = async () => {
    if (controller.current) return;
    const ctrl = new AbortController(); controller.current = ctrl;
    setBusy('choices'); setError('');
    try {
      const r = await request<QuizFeedbackChoices>('/api/quiz/feedback/choices', {
        method: 'POST', body: JSON.stringify(input), signal: ctrl.signal, timeoutMs: 45_000,
      });
      if (!ctrl.signal.aborted) setOptions(r.options);
    } catch (e) {
      if (!ctrl.signal.aborted) setError(`AI 预判暂未完成，你可以直接写评价。${e instanceof Error ? e.message : ''}`);
    } finally {
      if (controller.current === ctrl) { controller.current = null; setBusy(null); }
    }
  };
  const toggle = () => {
    if (open) { cancel(); setOpen(false); }
    else { setOpen(true); if (!options.length && !result) void predict(); }
  };
  const submit = async (feedback: string) => {
    if (!feedback.trim() || controller.current) return;
    const ctrl = new AbortController(); controller.current = ctrl;
    setBusy('adapt'); setError(''); setCustom(feedback); setResult(null);
    try {
      const r = await request<QuizFeedbackResult>('/api/quiz/feedback/adapt', {
        method: 'POST', body: JSON.stringify({ ...input, feedback: feedback.trim() }), signal: ctrl.signal, timeoutMs: 160_000,
      });
      if (!ctrl.signal.aborted) { setResult(r); if (!r.announced) onAdapted?.(r); }
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : '新题生成失败，请重试。');
    } finally {
      if (controller.current === ctrl) { controller.current = null; setBusy(null); }
    }
  };
  return { open, options, custom, setCustom, busy, error, result, toggle, predict, submit, cancel };
}
