import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScenarioPayload } from '@sb/shared';
import { SCENARIO_READY_TYPE, quizAnswerReady } from '@sb/shared';
import { validateScenarioReport } from './scenario-view';
import { useQuizRound } from './useQuizRound';
import { QuestionThinking } from './QuestionThinking';
import { QuestionAnalysis } from './QuestionAnalysis';
import { QuizRoundHistoryPanel } from './QuizRoundHistory';
import { QuizCard } from './QuizCard';
import { AnswerImpact, AnswerSoundToggle } from '../feedback/AnswerImpact';
import './quiz.css';
import './quiz-effects.css';

interface Props { sessionId?: string | null; quizId: string; payload: ScenarioPayload; demoId: string; recordId?: string }
/** Sandbox observations are judged against the owned criteria on whole-round submission. */
export function ScenarioPanel({ quizId, payload, demoId, sessionId, recordId }: Props) {
  const questions = useMemo(() => payload.tasks.map(t => ({ type: 'essay' as const, question: t.prompt, explanation: t.hint,
    scenarioTask: { id: t.id, demoId, criteria: t.criteria } })), [payload, demoId]);
  const rounds = useQuizRound({ title: payload.title, questions, origin: 'scenario', quizId, ...(sessionId ? { sessionId } : {}) }, recordId);
  const r = rounds.round, submitted = r?.state === 'submitted';
  const current = useRef(rounds); current.current = rounds;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [connected, setConnected] = useState(false);
  const [err, setErr] = useState('');
  const [nonce, setNonce] = useState(0);
  const [history, setHistory] = useState(false);
  const taskIds = useMemo(() => new Set(payload.tasks.map(t => t.id)), [payload]);
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (!frameRef.current || ev.source !== frameRef.current.contentWindow) return;
      const data = ev.data as { type?: string; v?: number; demoId?: string } | null;
      if (data?.type === SCENARIO_READY_TYPE && data.v === 1 && data.demoId === demoId) { setConnected(true); return; }
      const report = validateScenarioReport(ev.data, demoId, taskIds), state = current.current;
      if (!report || !state.round || state.round.state !== 'draft' || state.acting) return;
      const index = state.round.questions.findIndex(q => q.scenarioTask?.id === report.taskId);
      const response = state.round.responses[index];
      if (!response) return;
      try {
        const essay = JSON.stringify(report.observed);
        if (!essay || essay.length > 4000) throw new Error('invalid observation');
        state.change(index, { ...response.draft, essay }, response.thought); setErr('');
      } catch { setErr('操作记录过长或格式不正确，请重新操作。'); }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [demoId, taskIds]);
  useEffect(() => { setConnected(false); }, [r?.id]);
  const answered = r?.questions.filter((q, i) => quizAnswerReady(q, r.responses[i]!.draft)).length ?? 0;
  return <div className="sb-scenario quiz-adventure" data-quiz-id={quizId}>
    <header className="sb-scenario-head"><AnswerSoundToggle /><span className="sb-scenario-title">{r?.title ?? payload.title}</span>
      <span className="sb-scenario-live">{submitted ? '已交卷' : connected ? '沙箱已连接' : '沙箱连接中…'}</span>
      <span className="m">第 {r?.number ?? 1} 轮 · 已操作 {answered}/{r?.questions.length ?? questions.length}</span>
      {!submitted && <button className="quiz-gen-btn" onClick={() => { setNonce(n => n + 1); setConnected(false); }}>重开情景</button>}
    </header>
    <p className="quiz-muted">完成各项任务，按需记下思考与评价。交卷前可重新操作，提交整组后按情景规则判定并逐项分析。</p>
    {!submitted && <iframe key={`${r?.id}:${nonce}`} ref={frameRef} className="sb-scenario-frame" src={`/api/scenario/demo/${demoId}`}
      title={payload.title} sandbox="allow-scripts allow-modals allow-forms" />}
    {err && <p role="alert">{err}</p>}
    {rounds.error && <p role="alert">{rounds.error}<button className="quiz-gen-btn" onClick={rounds.save}>重试保存 / 读取</button></p>}
    {rounds.recovery && <p>发现本机未同步的草稿。<button onClick={rounds.restore}>恢复后核对</button></p>}
    {!r && <p role="status">正在恢复情景作答…</p>}
    {r?.questions.map((q, index) => {
      const response = r.responses[index]!, verdict = response.result?.verdict;
      return <section key={`${r.id}:${index}`} className="sb-scenario-task answer-surface">
        <strong>任务 {index + 1} · {q.question}</strong>
        <p>{response.draft.essay ? `本轮操作：${response.draft.essay}` : '等待操作'}</p>
        <QuestionThinking value={response.thought} disabled={!!submitted || rounds.acting} onChange={thought => rounds.change(index, response.draft, thought)} />
        {response.result && <><p>{verdict === 'correct' ? '判对' : '判错'} · 规则：{response.result.expected}</p>
          {q.explanation && <p>{q.explanation}</p>}<AnswerImpact verdict={verdict === 'correct' ? 'correct' : 'wrong'} />
          <QuestionAnalysis response={response} disabled={rounds.acting} onRetry={() => void rounds.retry(index)} /></>}
      </section>;
    })}
    <div className="quiz-round-actions">
      {r && !submitted && <button className="quiz-submit" disabled={answered !== r.questions.length || !answered || rounds.acting || rounds.saving}
        onClick={() => void rounds.submit()}>提交整组操作 · 逐项分析</button>}
      {submitted && r.latestId === r.id && !rounds.busy && <button className="quiz-gen-btn" disabled={rounds.acting} onClick={() => void rounds.next()}>再练一遍</button>}
      {rounds.busy && <button className="quiz-gen-btn" onClick={() => void rounds.cancel()}>停止未完成的生成</button>}
      {r?.previousId && <button className="quiz-gen-btn" disabled={rounds.acting} onClick={() => void rounds.previous()}>查看上一轮</button>}
      {r && r.latestId !== r.id && <button className="quiz-gen-btn" onClick={() => void rounds.latest()}>返回当前轮</button>}
      <span role="status">{submitted ? '操作、思考和已有分析已保存' : rounds.saving ? '正在保存…' : '输入自动保存 · 思考选填'}</span>
    </div>
    {rounds.streamError && <p role="status">{rounds.streamError}</p>}
    {!recordId && <button className="quiz-gen-btn" onClick={() => void rounds.flush().then(() => setHistory(true)).catch(() => undefined)}>作答历史</button>}
    {history && <QuizRoundHistoryPanel onClose={() => { setHistory(false); rounds.reload(); }} renderRound={id => <QuizCard key={id} recordId={id} title="历史作答" questions={[]} compact />} />}
  </div>;
}
