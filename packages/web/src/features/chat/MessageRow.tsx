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
import { processSummary } from './process-summary';
import { Markdown } from './Markdown';
import { ChevronDownIcon } from '../../components/icons';
import { QuizCard } from '../quiz/QuizCard';
import { ScenarioPanel } from '../quiz/ScenarioPanel';
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
  /** 过程折叠态：收口后默认一行摘要（hook 必须在早退之前调用） */
  const [procExpanded, setProcExpanded] = useState(false);
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

  // 情景题卡片（M3，契约 SCENARIO-SPEC §8）：宿主面板直接内嵌消息流——
  // iframe 必须留在本应用内（新标签页会断回传链），对错以服务端判分为准（面板内已钉）
  if (m.scenarioBlock) {
    return (
      <ScenarioPanel
        quizId={m.scenarioBlock.quizId ?? ''}
        payload={m.scenarioBlock.payload}
        demoId={m.scenarioBlock.demoId}
      />
    );
  }

  const hasSteps = (m.steps?.length ?? 0) > 0;
  const hasTasks = (m.tasks?.length ?? 0) > 0;
  const hasReasoning = !!m.reasoning;
  const hasProc = hasSteps || hasTasks || hasReasoning;
  // 无正文又无过程的 assistant 空行不渲染（工具轮的中间行会落到这里）
  if (!m.content && !hasProc) return null;
  /** 收口后的过程折叠：有正文的回答把过程折成一行摘要（主流口径），点开才展开。
      空正文的过程行（纯工具轮/被停止的半轮）没有正文可读，过程就是全部内容，不折。 */
  const collapsible = hasProc && !!m.content;

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
            {m.images && m.images.length > 0 && (
              <div className="chat-att-row">
                {m.images.map((img, i) => (
                  <img key={i} src={img.dataUrl} alt={img.name ?? '图片'} className="chat-att-thumb" />
                ))}
              </div>
            )}
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
          {/* 过程区排在回答之前，顺序与流式期一致（思考 → 任务 → 工具 → 正文）：
              收口瞬间过程从「页面级」挪进「消息内」。有正文的回答默认折成一行摘要
              （process-summary），点开才展开——长对话里过程不再喧宾夺主；
              空正文的过程行照常全量铺开（纯工具轮/被停止的半轮，过程就是全部内容）。 */}
          {hasProc && (!collapsible || procExpanded) && (
            <>
              {hasReasoning && <ThoughtPanel text={m.reasoning ?? ''} streaming={false} />}
              {hasTasks && <TaskPanel items={m.tasks ?? []} streaming={false} />}
              {hasSteps && <ToolSteps steps={m.steps ?? []} />}
            </>
          )}
          {collapsible && (
            <button
              type="button"
              className="proc-summary"
              aria-expanded={procExpanded}
              onClick={() => setProcExpanded((v) => !v)}
            >
              <ChevronDownIcon size={13} className={`proc-summary-chevron${procExpanded ? ' open' : ''}`} />
              <span>{procExpanded ? '收起过程' : processSummary({ reasoning: m.reasoning, tasks: m.tasks, steps: m.steps })}</span>
            </button>
          )}
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
