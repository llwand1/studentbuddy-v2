/**
 * chat/opening —— 「本轮首轮强制动作」的装配层（v18.4，2026-09-17）。
 *
 * 【这层要解决什么】
 * 同一个坑踩到第二次了：工具注册齐全、提示词也写了，但模型在 `tool_choice='auto'`
 * 下的出厂倾向是**先把答案讲完**，工具永远不被调用——`choice-nudge.ts` 记的是第一次，
 * `search-nudge.ts` 是第二次。第一次的解法是 grill-me：把「问不问」从模型手里收回给
 * **用户开关**；这一次（UI「联网已开」pill）走同一条路。
 *
 * 与 `search-nudge.ts` 的分工：nudge 管**输入侧词表**（用户说了「搜一下」才附硬指令），
 * 本文件管**开关侧**（用户在 UI 上开了联网，与他说什么无关）。两者互补，都指向同一个工具。
 *
 * 【为什么单独成文件】
 * `flow.ts` 已 399 行、门禁 400，装配与摘除各塞几行就顶破；且「开场指令」是会随实测
 * 反复调的**提示词**，与调度逻辑分开改更稳（先例：`chat/grill.ts`、`chat/choice-nudge.ts`，
 * 两者文件头都记着同一句话：`flow.ts` 贴门禁，塞进去会顶破）。
 *
 * 【强绑只有一个名额，所以有优先级】
 * `tool_choice` 一轮只能指向一个工具。grill 与联网同时打开时取 **grill 优先**：
 * `GRILL_PRE` 里有「你的第一个动作**必须**是调用 ask_choice」这种硬性表述，此时若强绑
 * search_web，提示词与出站参数互相打架，模型会在先搜还是先问之间摇摆（输出更不可控）；
 * 而 `SEARCH_FORCE` 是软性表述，turn 1 起 `auto` 仍会命中搜索，代价只是「换个轮次搜」。
 * 两害相权取轻——这条规则由 `opening.test.ts` 锁死，别静默改。
 */
import type { ChatMessage, ChatRequest } from '../llm/types.js';
import { GRILL_PRE, GRILL_TOOL_CHOICE } from './grill.js';

/**
 * 联网开关的硬指令（随开场指令一并 push 进 messages）。
 *
 * 刻意**不含**「你要是做不到就说没有」这类台阶——那正是 B-006 的病灶：
 * 09-09 那轮「我无法获取今日新闻，因为…没有联网功能」就是失败回灌里那句
 * 「或基于已有知识回答」的产物（见 `chat/tools.ts` 的 run 分支注释）。
 */
export const SEARCH_FORCE =
  '（本会话已开启联网搜索。）先用 search_web 检索一次再作答，把检索到的内容作为依据；' +
  '若检索无结果，如实说明"这次没搜到"即可，不要凭记忆编造时效性信息。';

/** 首轮强绑的工具选择（内部简写口径 `{type:'function',name}`，适配器负责转各家出站规范） */
export const SEARCH_TOOL_CHOICE = { type: 'function', name: 'search_web' } as const;

export interface OpeningFlags {
  /** grill-me 模式（每轮必出选择框，`chat/grill.ts`） */
  grill: boolean;
  /** 联网开关（UI「联网已开」pill，本文件） */
  online: boolean;
}

export interface Opening {
  /** 追加到 messages 尾部的开场硬指令；两个开关都关时为 null（无改动） */
  msg: ChatMessage | null;
  /** 首轮 `tool_choice`；无强绑时为 undefined（= 适配器默认 auto） */
  toolChoice: ChatRequest['toolChoice'];
  /** 本轮是否 grill-me 开场——`flow.ts` 据它给强绑产生的 ask_choice 打 `pre` 标记 */
  grill: boolean;
}

/**
 * 装配开场：开关 →（指令消息, 首轮强绑）。纯函数，便于单测与日后按模型能力分档下发。
 *
 * 两段指令合成**一条**消息（而非各 push 一条）：它们在上下文里同位置、同用途，
 * 拆成两条只会多占一次消息开销，还会让摘除逻辑要维护两个引用。
 */
export function buildOpening(flags: OpeningFlags): Opening {
  const parts: string[] = [];
  if (flags.grill) parts.push(GRILL_PRE);
  if (flags.online) parts.push(SEARCH_FORCE);
  return {
    msg: parts.length > 0 ? ({ role: 'user', content: parts.join('\n') } as ChatMessage) : null,
    // 强绑名额只有一个：grill 优先（理由见文件头）
    toolChoice: flags.grill ? GRILL_TOOL_CHOICE : flags.online ? SEARCH_TOOL_CHOICE : undefined,
    grill: flags.grill,
  };
}

/**
 * 摘掉开场指令（幂等：已摘过再调无副作用）。
 *
 * `flow.ts` 在**两个**位置调它，缺一不可：
 * - **首轮工具轮之后**（与 nudge 段摘除同处）：主路径。留到第二轮的代价不是「多几句话」，
 *   而是**行为跑偏**——联网指令说「先搜再答」，模型会每一轮都重搜直到撞上轮次上限；
 *   grill 指令则会让它答完又问一次（问第二次比不问还差）。这条由 `flow.test.ts`
 *   的「出循环即摘」用例锁着，别把调用点挪到循环外了事。
 * - **工具循环之外**：兜底。首轮没有工具调用时循环直接 break，走不到上面那个位置。
 */
export function dropOpening(messages: ChatMessage[], opening: Opening): void {
  if (!opening.msg) return;
  const i = messages.indexOf(opening.msg);
  if (i >= 0) messages.splice(i, 1);
}
