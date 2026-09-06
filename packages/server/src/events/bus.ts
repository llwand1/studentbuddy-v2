/**
 * events — 领域事件总线（演进②）：进程内 pub/sub。
 * 发布方：chat/quiz/terms 各域；订阅方：activity（M4 起）。
 * ADR-4：订阅者抛错只记日志，绝不阻塞发布方（对话主链）。
 */
import type { ObsEventBody } from '@sb/shared/obs';

export type DomainEvent =
  | { type: 'chat_done'; sessionId: string }
  | { type: 'quiz_generated'; quizId: string }
  | { type: 'quiz_answered'; quizId: string; correct: boolean }
  | { type: 'term_added'; count: number }
  /** 认知进化升级（COGNITIVE-EVOLUTION-SPEC §9.2）；XP 订阅在任务 10 接入 */
  | { type: 'evolution_levelup'; termId: string; term: string; from: number; to: number }
  /** 可观测（可观测与数据飞轮方案）；订阅方 storage/obs.ts，发布方 search/flow/quiz/点踩 */
  | ({ type: 'obs' } & ObsEventBody);

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
