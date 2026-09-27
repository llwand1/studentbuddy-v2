/**
 * QuizCard — 可交互题组卡片（五题型：single/multiple/fill/essay/judge）。
 * v1 教训：1886 行巨组件 → 本文件按 题干/作答/解析 子组件拆分，总量 ≤300 行红线内。
 *
 * ★ 2026-09-26 题库整族下线：唯一的调用方是聊天流的题卡（`chat/MessageRow.tsx`），
 *   所以卡片只做「作答 → 判分 → 出解析」，原先挂在这儿的三根外接线一并摘掉——
 *   上报对错（`/api/quiz/stats/record`）、逐题剔除（契约 docs/QUIZ-BLEND-SPEC.md §8 对冲④，
 *   那道闸门防的是「真题自动进组无人工确认」，而"进组"这个动作已经没有了）、以及 quizId。
 *
 * ★★ 2026-09-27（issue #56）quizId 与上报**回来了，但不是原来那两根线**：
 *   旧的那条 `/stats/record` 传的是**前端算好的布尔**，现在这条 `/api/quiz/report`
 *   只传原始作答，对错由服务端复判（老板拍板，逐字见 issue #56）。
 *   ⇒ 于是本文件里那次 `judgeQuizAnswer` 调用**只用于即时反馈**，屏幕上的勾最终跟服务端一致，
 *     因为服务端返回的 `correct` 会覆盖本地那份。两侧共用 `shared/quiz-judge.ts` 这一个函数，
 *     所以正常情况下一致；真出现不一致（题面被改过／浏览器被改包）以服务端为准是刻意的。
 *   ★ 上报**失败不阻断翻解析**：作答与解析是学习动作，记账是我们的统计需求。
 *     为了后者把前者的按钮禁掉，等于让用户体验替我们的指标买单。
 *
 * ⚠️ 判分口径**不在这里写**（别在本文件加任何 `q.answer` 比较）：见 `shared/quiz-judge.ts`。
 *   这里连"什么算选项题"都问它（`isChoiceQuestion`），因为 2026-09-20 加 `judge` 时
 *   本文件的选项渲染漏了它，判断题于是是一张答不了的死卡（没有选项按钮 ⇒ 提交永远 disabled），
 *   那份判据收进 shared 之后这类错只剩一种形状。
 */
import { useState } from 'react';
import { isChoiceQuestion, judgeQuizAnswer, type QuizQuestion } from '@sb/shared';
import { api } from '../../lib/api';
import { SvgPreviewCard } from '../chat/SvgPreviewCard';
import './quiz.css';

export function QuizCard({
  title,
  questions,
  quizId,
}: {
  title: string;
  questions: QuizQuestion[];
  /**
   * 本次题组的 id（`quiz_block` 主键）。缺它 = **老卡**（2026-09-23 之前落的历史行没有这个键），
   * 老卡照常作答、只是不记账——与 09-26 之前的行为一致，不炸流也不提示用户。
   */
  quizId?: string;
}) {
  return (
    <div className="quiz-card">
      <div className="quiz-head">{title}</div>
      {questions.map((q, i) => (
        <QuestionItem key={i} index={i} q={q} quizId={quizId} />
      ))}
    </div>
  );
}

/** 记账状态：只用来决定那一行小字怎么说，不参与任何判分 */
type Trail = 'idle' | 'recorded' | 'duplicate' | 'unjudged' | 'legacy' | 'failed';

/**
 * `recorded` 与 `idle` **故意不在这张表里**（渲染处也没有它们的分支）：
 * 记账成功是本功能的正常路径，为它出一行字等于每张卡都多一句没人要的"已记录"。
 */
const TRAIL_TEXT: Record<Exclude<Trail, 'idle' | 'recorded'>, string> = {
  duplicate: '这道题之前已经答过，这次不重复计入练习记录',
  unjudged: '这道题没有可对照的答案，未计入练习记录',
  legacy: '这是改版前出的旧题卡，作答不记录',
  failed: '练习记录没写上服务端（不影响看解析，刷新后重答会重新记一次）',
};

function QuestionItem({
  index,
  q,
  quizId,
}: {
  index: number;
  q: QuizQuestion;
  quizId?: string;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const [fillText, setFillText] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [verdict, setVerdict] = useState<boolean | null>(null);
  const [trail, setTrail] = useState<Trail>('idle');

  const typeLabel = { single: '单选', multiple: '多选', fill: '填空', essay: '解答', judge: '判断' }[q.type];
  const answerArr = Array.isArray(q.answer) ? q.answer : [];

  const toggle = (i: number) => {
    if (revealed) return;
    setPicked((p) => (q.type === 'multiple' ? (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]) : [i]));
  };

  const submit = () => {
    setRevealed(true);
    // 本地这份只负责"立刻有个反馈"；null = 这题不判（essay 走不到这儿，只可能是题面缺答案钥匙）
    setVerdict(judgeQuizAnswer(q, { picked, text: fillText }));
    if (!quizId) {
      setTrail('legacy');
      return;
    }
    api
      .request<{ ok: boolean; correct: boolean | null; recorded: boolean }>('/api/quiz/report', {
        method: 'POST',
        // ★ 发的是**作答**，不是对错：`verdict` 不进这个 body（这条请求里没有 correct 字段，
        //   服务端也就没有"信前端"这条路可走）。
        body: JSON.stringify({ quizId, index, picked, text: fillText }),
      })
      .then((r) => {
        setVerdict(r.correct);
        setTrail(r.correct === null ? 'unjudged' : r.recorded ? 'recorded' : 'duplicate');
      })
      // catch 是**必要的**不是防御性的：这条链路上"服务端没连上"在开发/弱网下天天发生，
      // 而它必须与"这题不判"在文案上分开——写成同一种会让用户以为答错了。
      .catch(() => setTrail('failed'));
  };

  return (
    <div className="quiz-q">
      <div className="quiz-q-title">
        <span className="quiz-q-type">{typeLabel}</span>
        {q.question}
      </div>

      {/* 配图：svg 由模型产出，属不可信内容——只经 SvgPreviewCard 渲染（内含 prepareSvg 净化），
          此处不得另开 dangerouslySetInnerHTML。契约 docs/QUIZ-IMAGE-SPEC.md §2.5 */}
      {q.svg && (
        <div className="quiz-q-svg">
          <SvgPreviewCard code={q.svg} streaming={false} />
        </div>
      )}

      {isChoiceQuestion(q) &&
        q.options?.map((opt, i) => {
          const isAnswer = revealed && answerArr.map(Number).includes(i);
          const isPicked = picked.includes(i);
          return (
            <button key={i} className={`quiz-opt${isPicked ? ' picked' : ''}${isAnswer ? ' right' : ''}`} onClick={() => toggle(i)}>
              <span className="quiz-opt-key">{String.fromCharCode(65 + i)}</span>
              {opt}
              {revealed && isAnswer && <span className="quiz-mark ok">✓</span>}
              {revealed && isPicked && !isAnswer && <span className="quiz-mark bad">✗</span>}
            </button>
          );
        })}

      {q.type === 'fill' && (
        <input
          className="quiz-fill"
          placeholder="输入答案"
          value={fillText}
          disabled={revealed}
          onChange={(e) => setFillText(e.target.value)}
        />
      )}
      {q.type === 'essay' && <textarea className="quiz-essay" placeholder="写下你的解答（对照参考要点）" rows={3} disabled={revealed} />}

      {!revealed && q.type !== 'essay' && (
        <button className="quiz-submit" disabled={q.type === 'fill' ? !fillText.trim() : picked.length === 0} onClick={submit}>
          提交
        </button>
      )}

      {revealed && (
        <div className="quiz-explain">
          {q.type === 'essay' ? (q.solution ?? q.answer) : (
            <>
              <b>答案：</b>
              {isChoiceQuestion(q) ? answerArr.map((a) => String.fromCharCode(65 + Number(a))).join('、') : answerArr.join('；')}
              {/* ★ 判分归服务端，这一行读的是**响应回来的那个 `correct`**（本地那份只是它到之前的占位，
                  见上面 submit 的注释）。`verdict === null` 三种成因合成一句「这题不判分」——
                  essay 走不到这里（没有提交按钮），所以剩下的都是题面缺答案钥匙，对用户是同一件事。 */}
              {verdict !== null && (
                <span className={verdict ? 'quiz-verdict ok' : 'quiz-verdict bad'}>{verdict ? '答对了' : '答错了'}</span>
              )}
              {verdict === null && <span className="quiz-verdict">这题不判分</span>}
            </>
          )}
          {/* 记账状态单独一行、且**只在非正常情况下**出声：记上了不邀功（那是本该发生的），
              失败与重复必须说清——"没连上服务端"和"这题你答过了"是两句不同的话，混成一句
              用户就没有任何线索判断刷新有没有用。 */}
          {(trail === 'failed' || trail === 'duplicate' || trail === 'legacy' || trail === 'unjudged') && (
            <div className="quiz-trail">{TRAIL_TEXT[trail]}</div>
          )}
          {(q.explanation || q.solution) && <div className="quiz-explain-body">{q.explanation ?? q.solution}</div>}
          {q.source && (
            <div className="quiz-source">
              来源：
              {q.source.url ? (
                <a href={q.source.url} target="_blank" rel="noreferrer noopener">
                  {q.source.title}
                </a>
              ) : (
                q.source.title
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
