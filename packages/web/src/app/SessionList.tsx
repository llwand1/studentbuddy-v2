/**
 * SessionList —— 侧栏「历史对话」列表（**纯展示 + 三个回调**，不持有任何状态）。
 *
 * 2026-09-20 从 `App.tsx` 拆出：加完词条卡「向 AI 追问」的接线后 `App.tsx` 涨到 322 行，
 * 触 web `.tsx ≤300` 红线。按仓规**拆文件、不压注释**（同此前 `RoleRow` / `api-settings` 的手法）。
 *
 * ★ 为什么切的是这一段：它是壳里**唯一**一块"给数据就渲染"的纯展示区——其余部分
 *   （侧栏头部、导航、跨页动作）都在持有状态、决定动线。所以拆完 `App` 只多一组 props，
 *   而这一段将来改版（加分组、加拖拽）不必再碰壳的状态逻辑。
 *
 * ★ 高亮由 `activeId` 这一个 prop 决定，**不是**传 `currentId` + `view` 两个再在里面判断：
 *   "在对话页才高亮"属于**壳的动线知识**，不该漏进一个纯展示组件（同仓跨页组件的既有口径）。
 */
import type { Session } from '@sb/shared';
import { PinIcon } from '../components/icons';

export function SessionList({
  sessions,
  activeId,
  collapsed,
  busy,
  emptyHint,
  onOpen,
  onTogglePin,
  onRemove,
}: {
  sessions: Session[];
  /** 当前高亮的会话 id；`null` = 不在对话页，谁都别高亮 */
  activeId: string | null;
  /** 收起态（只保留标题栏，列表不渲染） */
  collapsed: boolean;
  /** 正在生成回复的会话 id 集合（服务端 `GET /chat/active` ∪ 本地流，见 `useActiveSessions`） */
  busy: ReadonlySet<string>;
  /** 列表为空时的提示；`null` = **一条会话都没有**（与"搜不到"是两回事，后者才该有文案） */
  emptyHint: string | null;
  onOpen: (id: string) => void;
  onTogglePin: (session: Session) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className={collapsed ? 'sb-session-list collapsed' : 'sb-session-list'}>
      {sessions.map((s) => (
        <div
          key={s.id}
          className={activeId === s.id ? 'sb-session active' : 'sb-session'}
          onClick={() => onOpen(s.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && onOpen(s.id)}
        >
          <span className="sb-session-title">{s.title || '新对话'}</span>
          {/* 「回复中」有两个信号源（本地流 token 级 + 服务端 2s 轮询），并集见 useActiveSessions */}
          {busy.has(s.id) && (
            <span className="sb-session-busy" role="status">
              <span className="sb-session-busy-dot" />
              回复中
            </span>
          )}
          <button
            className={s.pinned ? 'sb-session-pin pinned' : 'sb-session-pin'}
            title={s.pinned ? '取消置顶' : '置顶'}
            onClick={(e) => {
              // stopPropagation 必做：不加就同时触发外层行的 openSession（既置顶又切会话）
              e.stopPropagation();
              onTogglePin(s);
            }}
          >
            <PinIcon size={13} />
          </button>
          <button
            className="sb-session-del"
            title="删除"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(s.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
      {sessions.length === 0 && emptyHint && <div className="sb-session-empty">{emptyHint}</div>}
    </div>
  );
}
