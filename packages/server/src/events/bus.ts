/**
 * events — 领域事件总线（演进②）：进程内 pub/sub。
 * 发布方：chat/quiz/terms 各域；订阅方：activity（M4 起）。
 * ADR-4：订阅者抛错只记日志，绝不阻塞发布方（对话主链）。
 */
export type DomainEvent =
  | { type: 'chat_done'; sessionId: string }
  | { type: 'quiz_generated'; quizId: string }
  | { type: 'quiz_answered'; quizId: string; correct: boolean }
  | { type: 'term_added'; count: number };

type Handler = (ev: DomainEvent) => void | Promise<void>;
const handlers = new Set<Handler>();

export function subscribeEvents(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function publishEvent(ev: DomainEvent): void {
  for (const h of [...handlers]) {
    try {
      void Promise.resolve(h(ev)).catch((err) => {
        console.error('[events] subscriber failed:', err instanceof Error ? err.message : err);
      });
    } catch (err) {
      console.error('[events] subscriber threw:', err instanceof Error ? err.message : err);
    }
  }
}
