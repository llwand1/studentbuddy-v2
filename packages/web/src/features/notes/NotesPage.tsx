/**
 * NotesPage — 刷题笔记一级页（契约 docs/QUIZ-NOTES-SPEC.md）。
 * 草稿由「提交答案」自动落库，本页只做：筛选总览（全部/错题/某套题）→ 详情
 * （结构化快照区：题干/我的作答/正确答案/解析 + 手写心得 Markdown 区）。
 * 详情区结构化字段只读——那是自动流程的快照；用户只拥有心得 body。
 */
import { useCallback, useEffect, useState } from 'react';
import type { QuizNote, QuizNoteSummary } from '@sb/shared';
import { api } from '../../lib/api';
import { Markdown } from '../chat/Markdown';
import { SvgPreviewCard } from '../chat/SvgPreviewCard';
import { formatCorrectAnswer, formatMyAnswer } from './note-format';
import './notes.css';

const TYPE_LABELS: Record<string, string> = { single: '单选', multiple: '多选', fill: '填空', essay: '解答' };

export function NotesPage({ quizId, onClearQuiz }: { quizId?: string | null; onClearQuiz?: () => void }) {
  const [notes, setNotes] = useState<QuizNoteSummary[]>([]);
  const [wrongOnly, setWrongOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const reload = useCallback(async () => {
    try {
      setNotes(await api.notes.list({ quizId: quizId ?? undefined, wrong: wrongOnly }));
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [quizId, wrongOnly]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (openId) {
    return (
      <NoteDetail
        id={openId}
        onBack={() => {
          setOpenId(null);
          void reload();
        }}
      />
    );
  }

  return (
    <div className="notes-page">
      <h2>刷题笔记</h2>
      <div className="notes-filters">
        <button className={wrongOnly ? 'notes-chip' : 'notes-chip active'} onClick={() => setWrongOnly(false)}>
          全部
        </button>
        <button className={wrongOnly ? 'notes-chip active' : 'notes-chip'} onClick={() => setWrongOnly(true)}>
          只看错题
        </button>
        {quizId && (
          <button className="notes-chip notes-chip-clear" onClick={() => onClearQuiz?.()}>
            按套题过滤 ✕
          </button>
        )}
      </div>
      {err && <div className="notes-err">{err}</div>}
      {notes.map((n) => (
        <div key={n.id} className="notes-item" onClick={() => setOpenId(n.id)} role="button" tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setOpenId(n.id)}>
          <span className={n.correct ? 'notes-mark ok' : 'notes-mark bad'}>{n.correct ? '对' : '错'}</span>
          <span className="t">{n.question || '（无题干）'}</span>
          <span className="m">
            {n.quizTitle} · 第 {n.questionIndex + 1} 题 · {n.updatedAt?.slice(0, 10)}
            {n.hasBody ? ' · 已写心得' : ' · 草稿'}
          </span>
        </div>
      ))}
      {notes.length === 0 && !err && (
        <div className="notes-empty">
          还没有笔记——去题库或对话里做题，提交答案后会自动生成一篇。
        </div>
      )}
    </div>
  );
}

function NoteDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [note, setNote] = useState<QuizNote | null>(null);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tip, setTip] = useState('');

  useEffect(() => {
    api.notes
      .get(id)
      .then((n) => {
        setNote(n);
        setDraft(n.body);
      })
      .catch((e) => setTip(e instanceof Error ? e.message : String(e)));
  }, [id]);

  const save = async () => {
    setSaving(true);
    setTip('');
    try {
      await api.notes.saveBody(id, draft);
      setDirty(false);
      setTip('已保存');
    } catch (e) {
      setTip(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    await api.notes.remove(id).catch(() => undefined);
    onBack();
  };

  if (!note) return <div className="notes-page">{tip || '加载中…'}</div>;

  const q = note.questionData;
  const answerArr = Array.isArray(q.answer) ? q.answer : [];
  const picked = Array.isArray(note.myAnswer) ? note.myAnswer : [];

  return (
    <div className="notes-page">
      <button className="notes-back" onClick={onBack}>
        ← 返回笔记列表
      </button>
      <div className="notes-detail-head">
        <h2>{note.quizTitle} · 第 {note.questionIndex + 1} 题</h2>
        <span className={note.correct ? 'notes-mark ok' : 'notes-mark bad'}>{note.correct ? '答对' : '答错'}</span>
      </div>

      <div className="notes-block">
        <span className="quiz-q-type">{TYPE_LABELS[q.type] ?? q.type}</span>
        {q.question}
        {q.svg && (
          <div className="quiz-q-svg">
            <SvgPreviewCard code={q.svg} streaming={false} />
          </div>
        )}
        {q.options?.map((opt, i) => {
          const isAnswer = answerArr.map(Number).includes(i);
          const isPicked = picked.includes(i);
          return (
            <div key={i} className={`notes-opt${isAnswer ? ' right' : ''}${isPicked && !isAnswer ? ' wrong' : ''}`}>
              <span className="quiz-opt-key">{String.fromCharCode(65 + i)}</span>
              {opt}
              {isAnswer && <span className="quiz-mark ok">✓</span>}
              {isPicked && !isAnswer && <span className="quiz-mark bad">✗</span>}
            </div>
          );
        })}
      </div>

      <div className="notes-block">
        <div className="notes-kv">
          <b>我的作答：</b>
          {formatMyAnswer(q, note.myAnswer)}
        </div>
        <div className="notes-kv">
          <b>正确答案：</b>
          {formatCorrectAnswer(q)}
        </div>
      </div>

      {(q.explanation || q.solution) && (
        <div className="notes-block">
          <div className="notes-kv-label">解析</div>
          <div className="notes-md">
            <Markdown text={q.explanation ?? q.solution ?? ''} />
          </div>
        </div>
      )}

      <div className="notes-block">
        <div className="notes-kv-label">我的心得</div>
        <textarea
          className="notes-body-input"
          placeholder="记下错因、思路卡点、同类题的解法……支持 Markdown"
          value={draft}
          rows={6}
          onChange={(e) => {
            setDraft(e.target.value);
            setDirty(true);
          }}
        />
        <div className="notes-body-actions">
          <button className="notes-save" disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? '保存中…' : '保存心得'}
          </button>
          <button className="notes-del" onClick={() => void remove()}>
            删除笔记
          </button>
          {tip && <span className="notes-tip">{tip}</span>}
        </div>
        {draft.trim() && (
          <div className="notes-md notes-md-preview">
            <Markdown text={draft} />
          </div>
        )}
      </div>
    </div>
  );
}
