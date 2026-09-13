/**
 * composer-status — 输入框「+」菜单收起时显示的状态摘要（纯函数，可测）。
 *
 * 为什么需要它：「联网开关」是**状态**不是动作，而它现在被收进了折叠菜单——收进去就看不见
 * 当前开没开了（这是折叠菜单的固有代价）。折中办法是让菜单**标题行**带上状态摘要，
 * 于是「一眼能看出联网开着」这个属性没有丢。
 *
 * 判定留在这里而不是组件里：本仓 `.tsx` 无测试环境，逻辑写进组件就进了不了测链路
 * （先例 `features/quiz/mix-report.ts`、`features/chat/doc-name.ts`）。
 */

/** 资料名在摘要里最多显示几个字（超出截断加省略号）——状态行要短，不能把「+」撑成一整行 */
const NAME_CLIP = 10;

const clip = (s: string, max = NAME_CLIP): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * 组装菜单标题的状态摘要。返回 `null` 表示「没什么要说的」——此时标题只显示「+」，
 * 不留一句空话（ADR-5 只说不静默，不要求无话找话）。
 *
 * 规矩：
 * ① 联网开着必须说（这是本次收进菜单后唯一会丢失可见性的状态）；
 * ② 联网关着**什么都不说**——关掉是用户的主动选择，不是需要提醒的异常；
 * ③ 已载入资料时报「资料 xxx」，让用户知道这轮回答会依据资料（同样是收进菜单后失去可见性的状态）；
 * ④ 空串 / 纯空白的资料名按「没有」处理（`meta.name` 在极端情况下可能是空串）。
 */
export function menuStatus(opts: { online: boolean; docBase?: string | null }): string | null {
  const parts: string[] = [];
  if (opts.online) parts.push('联网已开');
  const base = opts.docBase?.trim();
  if (base) parts.push(`资料 ${clip(base)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}
