/**
 * MessageRow —— 单条消息的渲染单元（从 ChatView 抽出）。
 *
 * 抽出的两个理由：
 * ① ChatView 卡在 300 行门禁上（299/300），把消息渲染搬出去才有空间做过程归属；
 * ② 过程（思考 / 任务清单 / 工具卡片）从此**属于这条消息**：挂在回答气泡上下文渲染，
 *    随消息一起回放（数据来自 history-fold，或流式 done 时的归并），重开会话不丢。
 *
 * 渲染条件：正文为空但带过程的 assistant 消息**照样渲染**（纯工具轮 / 被停止的半轮），
 * 否则「没有正文」会把整段过程一起吞掉。
 *
 * 编辑重发（v13）：只挂最后一条用户提问（canEdit，与「重新生成只挂最后一条回答」同一条
 * 产品决策——编辑更早的提问意味着改写历史分叉）。悬停浮现入口，点击就地上出编辑态。
 */
import { useRef, useState } from 'react';
import type { StreamMessage } from './useChatStream';
import { ThoughtPanel } from './ThoughtPanel';
import { TaskPanel } from './TaskPanel';
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
  canEdit = false,
  editDisabled = false,
  onEdit,
}: {
  m: StreamMessage;
  /** 是不是最后一条回答（只有它给「重新生成」按钮） */
  canRegen: boolean;
  regenDisabled: boolean;
  onRegen: () => void;
  /** 是不是最后一条提问（只有它给「编辑重发」入口） */
  canEdit?: boolean;
  editDisabled?: boolean;
  onEdit?: (text: string) => void;
}) {
  /** 就地编辑态：点「编辑」后原气泡换成 textarea；保存把新文案交回 ChatView 走 resend */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const editRef = useRef<HTMLTextAreaElement>(null);

  if (m.quizBlock) {
    return (
      <QuizCard
        title={m.quizBlock.quiz.title ?? '练习'}
        questions={m.quizBlock.quiz.questions}
        quizId={m.quizBlock.quizId}
        onAnswer={(qi, correct, ans) => {
          if (m.quizBlock?.quizId) {
            void api.request('/api/quiz/stats/record', {
              method: 'POST',
              body: JSON.stringify({
                quizId: m.quizBlock.quizId,
                questionIndex: qi,
                correct,
                ...(ans !== undefined ? { answer: ans } : {}),
              }),
            });
          }
        }}
      />
    );
  }

  const hasSteps = (m.steps?.length ?? 0) > 0;
  const hasTasks = (m.tasks?.length ?? 0) > 0;
  const hasReasoning = !!m.reasoning;
  // 无正文又无过程的 assistant 空行不渲染（工具轮的中间行会落到这里）
  if (!m.content && !hasSteps && !hasTasks && !hasReasoning) return null;

  return (
    <div className={m.role === 'user' ? 'chat-row user' : 'chat-row'}>
      {m.role === 'user' ? (
        editing ? (
          // 编辑态：textarea 预填原文，保存走 resend（新文案整条替换提问并重跑）
          <div className="msg-editing">
            <textarea
              ref={editRef}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter 发送（Shift+Enter 换行），与 composer 同一手势
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!editDisabled && draft.trim()) {
                    setEditing(false);
                    onEdit?.(draft.trim());
                  }
                }
              }}
            />
            <div className="msg-editing-actions">
              <button type="button" onClick={() => setEditing(false)}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                disabled={editDisabled || !draft.trim()}
                onClick={() => {
                  setEditing(false);
                  onEdit?.(draft.trim());
                }}
              >
                保存并重发
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="chat-bubble user">{m.content}</div>
            {canEdit && (
              <button
                type="button"
                className="msg-edit-trigger"
                disabled={editDisabled}
                onClick={() => {
                  setDraft(m.content);
                  setEditing(true);
                }}
              >
                编辑重发
              </button>
            )}
          </>
        )
      ) : (
        <>
          {/* 过程区一律排在回答之前，顺序与流式期一致（思考 → 任务 → 工具 → 正文）：
              收口瞬间过程从「页面级」挪进「消息内」，位置不变，不会跳到正文下面；
              重开会话时 history-fold 从库内重建同一份过程，渲染完全一致 → 刷新前后不跳版。 */}
          {hasReasoning && <ThoughtPanel text={m.reasoning ?? ''} streaming={false} />}
          {hasTasks && <TaskPanel items={m.tasks ?? []} streaming={false} />}
          {hasSteps && <ToolSteps steps={m.steps ?? []} />}
          {m.content && (
            <div className="chat-bubble md">
              <Markdown text={m.content} />
            </div>
          )}
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
