/**
 * LearnerModelCard — 复习面板底部的「学习画像」：快忘的词条（FSRS 可提取度）、尚未纠正的误区（AI 评分诊断）、
 * 各题型正确率与记忆模型校准。
 * ★ 这些都是 AI 在对话与出题时会参考的同一份数据（服务端 `learning/learner-model.ts`）——让学习者看得见
 *   "AI 以为我哪里不会"，并能对误判的误区说一句「我懂了」。
 * ★ 空模型整卡不渲染：新用户看到一张全是"暂无"的卡只是噪音。
 */
import { useEffect, useState } from 'react';
import type { LearnerModel } from '@sb/shared';
import { aiOpsApi } from '../../lib/api-ai-ops';

const QTYPE: Record<string, string> = { choice: '单选', multi: '多选', judge: '判断', fill: '填空', short: '解答', scene: '情景', match: '连线' };

export function qtypeLabel(q: string): string {
  return QTYPE[q] ?? q;
}

/** 校准的一句人话：实际记住率比预测低 10 个点以上 ⇒ 调度偏乐观，反之偏保守 */
export function calibrationText(c: NonNullable<LearnerModel['calibration']>): string {
  const p = Math.round(c.predicted * 100);
  const a = Math.round(c.actual * 100);
  const verdict = a < p - 10 ? '实际比预测差，复习间隔对你偏长' : a > p + 10 ? '实际比预测好，复习间隔对你偏保守' : '预测与实际接近，排期可信';
  return `近 ${c.n} 次复习：预测记住 ${p}%，实际 ${a}% · ${verdict}`;
}

export function LearnerModelCard({ refreshKey }: { refreshKey: number }) {
  const [model, setModel] = useState<LearnerModel | null>(null);

  useEffect(() => {
    let live = true;
    aiOpsApi
      .model()
      .then((m) => live && setModel(m))
      .catch(() => live && setModel(null));
    return () => {
      live = false;
    };
  }, [refreshKey]);

  if (!model) return null;
  const { weakTerms, misconceptions, byType, calibration } = model;
  const level = model.ability?.level ?? null;
  const fsrs = model.fsrs ?? null;
  if (weakTerms.length === 0 && misconceptions.length === 0 && byType.length === 0 && !calibration && !level && !fsrs) return null;

  const resolve = async (id: string) => {
    await aiOpsApi.resolveMisconception(id).catch(() => undefined);
    setModel((m) => (m ? { ...m, misconceptions: m.misconceptions.filter((x) => x.id !== id) } : m));
  };

  return (
    <section className="rv-learner" aria-label="学习画像">
      <div className="rv-learner-head">
        <b>学习画像</b>
        <span className="rv-learner-hint">AI 讲解与出题会参考这里</span>
      </div>
      {weakTerms.length > 0 && (
        <div className="rv-learner-row">
          <span className="rv-learner-k">快忘了</span>
          <span>{weakTerms.map((w) => `${w.term} ${Math.round(w.retention * 100)}%`).join('、')}</span>
        </div>
      )}
      {misconceptions.length > 0 && (
        <div className="rv-learner-row">
          <span className="rv-learner-k">误区</span>
          <ul className="rv-learner-list">
            {misconceptions.map((m) => (
              <li key={m.id}>
                {m.topic && <b>{m.topic}：</b>}
                {m.note}
                {m.count > 1 && <span className="rv-learner-count">×{m.count}</span>}
                <button className="rv-btn" onClick={() => void resolve(m.id)}>我懂了</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {byType.length > 0 && (
        <div className="rv-learner-row">
          <span className="rv-learner-k">题型</span>
          <span>{byType.map((t) => `${qtypeLabel(t.qtype)} ${t.correct}/${t.answers}`).join(' · ')}</span>
        </div>
      )}
      {level && (
        <div className="rv-learner-row">
          <span className="rv-learner-k">难度</span>
          <span>建议「{level}」档 · 出题会按它调整，让你大约答对七到八成</span>
        </div>
      )}
      {calibration && <div className="rv-learner-cal">{calibrationText(calibration)}</div>}
      {fsrs && <div className="rv-learner-cal">{personalText(fsrs)}</div>}
    </section>
  );
}

/** 个人化记忆模型的人话：k 是「你的记忆比默认模型稳多少」，间隔跟着按比例变 */
export function personalText(p: NonNullable<LearnerModel['fsrs']>): string {
  const base = `记忆模型已按你的 ${p.n} 次复习个人化`;
  if (Math.abs(p.scale - 1) < 0.05) return `${base}：你的遗忘节奏和默认模型基本一致，间隔不变。`;
  const pctDiff = Math.round(Math.abs(p.scale - 1) * 100);
  return p.scale > 1
    ? `${base}：你记得比默认模型以为的牢，复习间隔拉长约 ${pctDiff}%。`
    : `${base}：你忘得比默认模型以为的快，复习间隔缩短约 ${pctDiff}%。`;
}
