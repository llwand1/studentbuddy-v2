/**
 * MessageRow —— 单条消息的渲染单元（从 ChatView 抽出）。
 *
 * 抽出的两个理由：
 * ① ChatView 卡在 300 行门禁上（299/300），把消息渲染搬出去才有空间做过程归属；
 * ② 过程卡片（steps）从此**属于这条消息**：挂在回答气泡下面，随消息一起渲染，
 *    重开会话也能原样回放（数据来自 history-fold 或流式 done 时的归并）。
 *
 * 渲染条件：正文为空但带 steps 的消息**照样渲染**（纯工具轮 / 被停止的半轮），
 * 否则「没有正文」会把过程一起吞掉。
 */
import type { StreamMessage } from './useChatStream';
import { ToolSteps } from './ToolSteps';
import { MessageFoot } from './MessageFoot';
import { Markdown } from './Markdown';
import { QuizCard } from '../quiz/QuizCard';
import { api } from '../../lib/api';

export function MessageRow({
  m,
  canRegen,
  regenDisabled,
  onRegen,
}: {
  m: StreamMessage;
  /** 是不是最后一条回答（只有它给「重新生成」按钮） */
  canRegen: boolean;
  regenDisabled: boolean;
  onRegen: () => void;
}) {
  if (m.quizBlock) {
    return (
      <QuizCard
        title={m.quizBlock.quiz.title ?? '练习'}
        questions={m.quizBlock.quiz.questions}
        quizId={m.quizBlock.quizId}
        onAnswer={(qi, correct) => {
          if (m.quizBlock?.quizId) {
            void api.request('/api/quiz/stats/record', {
              method: 'POST',
              body: JSON.stringify({ quizId: m.quizBlock.quizId, questionIndex: qi, correct }),
            });
          }
        }}
      />
    );
  }

  const hasSteps = (m.steps?.length ?? 0) > 0;
  // 无正文又无过程的 assistant 空行不渲染（工具轮的中间行会落到这里）
  if (!m.content && !hasSteps) return null;

  return (
    <div className={m.role === 'user' ? 'chat-row user' : 'chat-row'}>
      {m.role === 'user' ? (
        <div className="chat-bubble user">{m.content}</div>
      ) : (
        <>
          {m.content && (
            <div className="chat-bubble md">
              <Markdown text={m.content} />
            </div>
          )}
          {hasSteps && <ToolSteps steps={m.steps ?? []} />}
        </>
      )}
      {/* 操作条只挂在有正文的消息上：空正文的过程行不该带一份「复制/重新生成」 */}
      {m.content && (
        <MessageFoot
          ts={m.ts}
          content={m.content}
          canRegen={canRegen}
          regenDisabled={regenDisabled}
          onRegen={onRegen}
        />
      )}
    </div>
  );
}
