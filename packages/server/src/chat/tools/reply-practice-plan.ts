import { emptyQuizImageReport } from '@sb/shared';
import type { ToolContext, PendingWrite } from './registry.js';
import { deliverReplyPractice, latestReplyPractice } from '../../learning/reply-practice.js';
import { quizToolSummary } from './generate-quiz-format.js';

export function replyPracticePlan(args: Record<string, unknown>, ctx: ToolContext): PendingWrite | null {
  if (args.fromReply !== true || !ctx.sessionId || args.search === true ||
      (args.count !== undefined && Number(args.count) !== 1)) return null;
  const quiz = latestReplyPractice(ctx.sessionId, ctx.ownerId, true);
  if (!quiz) return null;
  const sessionId = ctx.sessionId;
  return { affected: 1, actionSummary: '取用本次讲解已提炼的 1 道回忆练习', items: quiz.questions.map((q) => q.question),
    apply: async () => {
      deliverReplyPractice(sessionId, ctx.ownerId, quiz);
      return { content: quizToolSummary(quiz, emptyQuizImageReport(), { realRequested: 0, scenarioSkipped: false }), meta: { affected: 1 } };
    },
  };
}
