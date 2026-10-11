/** 篝火开场题：形状、排重与带题开聊的同源契约（CHAT-UX-SPEC §2.10）。 */
export interface CampfireQuestion {
  topic: string;
  question: string;
  options: string[];
  answer: number;
  explanation: string;
}

export interface CampfireOpener {
  id: string;
  question: CampfireQuestion;
  scope: string;
  preparation?: import('./question-seeds.js').QuestionPreparation;
}

export const OPENER_HISTORY_LIMIT = 8;
export const OPENER_QUESTION_MAX = 400;

export function openerFingerprint(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
}

/** 超长或非法内容整体拒绝，不能裁掉选项后把答案移到错误的位置。 */
export function normalizeCampfireQuestion(value: unknown, exclude: string[] = []): CampfireQuestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const q = value as Record<string, unknown>;
  const text = (v: unknown, max: number): string | null => typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null;
  const topic = text(q.topic, 40);
  const question = text(q.question, OPENER_QUESTION_MAX);
  const explanation = text(q.explanation, 600);
  if (!topic || !question || !explanation || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) return null;
  const options = q.options.map(v => text(v, 160));
  if (options.some(v => v === null) || new Set(options.map(v => openerFingerprint(v ?? ''))).size !== options.length) return null;
  // 卷轴是纯文字；模型偶尔违反提示返回代码围栏，交由网关重新出题。
  if ([topic, question, explanation, ...options].some(v => /```|~~~/.test(v ?? ''))) return null;
  // 热身只考概念或一步运算；多行数值矩阵易在转写或计算时出错，交由模型重创作。
  const content = [question, explanation, ...options].join('\n');
  if (/\bdiag\s*\(\s*[-+]?\d/i.test(content) || (content.match(/\[[^\]]*\]/g) ?? []).some(block => block.split(/[;；\n]/).filter(row => /\d/.test(row)).length > 1)) return null;
  if (options.some(v => /^[A-D][.、:：)]\s+/.test(v ?? ''))) return null;
  if (typeof q.answer !== 'number' || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= options.length) return null;
  if (/根据(?:上|下|所给)(?:图|表|文|材料)|如图所示|见图|见表/.test(question)) return null;
  if (exclude.some(stem => openerFingerprint(stem) === openerFingerprint(question))) return null;
  return { topic, question, explanation, options: options as string[], answer: q.answer };
}

export function parseOpenerRequest(value: unknown): { exclude: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { exclude = [] } = value as Record<string, unknown>;
  if (!Array.isArray(exclude) || exclude.length > OPENER_HISTORY_LIMIT || exclude.some(v => typeof v !== 'string' || v.length > OPENER_QUESTION_MAX)) return null;
  return { exclude: exclude.map(v => (v as string).trim()).filter(Boolean) };
}

/** 首问自足：新建会话后模型没有欢迎页的上下文。 */
export function openerChatPrompt(q: CampfireQuestion, choice: number | null): string {
  const options = q.options.map((text, i) => `${String.fromCharCode(65 + i)}. ${text}`).join('\n');
  return `我们从这道热身题开始聊：\n主题：${q.topic}\n${q.question}\n${options}\n${choice === null ? '我还没作答。' : `我选了 ${String.fromCharCode(65 + choice)}。`}\n参考答案：${String.fromCharCode(65 + q.answer)}\n参考解析：${q.explanation}\n请解释为什么这样选，用一个直观例子讲清考点，再顺着这个问题和我聊。`;
}
