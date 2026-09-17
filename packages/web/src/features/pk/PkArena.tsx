/**
 * PkArena — 对局中的**对阵布局**（UX 批，2026-09-15 老板点单「改成横屏设计不就行了吗」）。
 *
 * ★ 为什么改横屏：竖屏把「比分／主题／待答／出题／已发／已判定／投降」七个区块纵向堆在一起，
 *   375px 宽下每块都只能压扁，按钮自然挤成一团（老板实测原话「按键都挤在一起」）。
 *   横屏拆成 **左（对手）｜中（当前该做的事）｜右（我）** 三栏：两侧是**只读**的比分信息，
 *   中央只放**当前唯一要做的事**——同屏元素减半，层级反而更清楚。
 *
 * ★ 竖屏**不锁死**：`sb-pk-arena` 在窄屏下由 CSS 回落成上下排列（对手在上、我在下），
 *   照样能玩。不做「请旋转手机」的全屏遮罩——**拿提示挡住功能**是本仓既有教训，
 *   功能本身必须先可用，横屏只是它更好的形态。
 */
import type { ReactNode } from 'react';
import { isAiUserId, type PkPlayer, type PkRoomState } from '@sb/shared';

interface Props {
  state: PkRoomState;
  userId: string;
  /** 中央区：答题 / 出题 / 出题中的过渡提示，由 `PkMatch` 决定当前该显示哪一个 */
  children: ReactNode;
}

/** 一侧的玩家卡（横屏在左/右，竖屏回落成上/下） */
function SideCard({ player, label }: { player: PkPlayer | undefined; label: string }) {
  if (!player) {
    return (
      <div className="sb-pk-arena-side empty">
        <span className="sb-pk-side-label">{label}</span>
        <span className="sb-pk-sub dim">未入座</span>
      </div>
    );
  }
  return (
    <div className="sb-pk-arena-side">
      <span className="sb-pk-side-label">{label}</span>
      <span className="sb-pk-nick">
        {player.nickname}
        {isAiUserId(player.userId) && <span className="sb-pk-ai-tag">AI</span>}
      </span>
      <span className="sb-pk-arena-score">{player.score}</span>
      <span className="sb-pk-sub">
        答对 {player.correct}/{player.answered}
      </span>
      <span className="sb-pk-sub">求助 {player.helpLeft}</span>
    </div>
  );
}

export function PkArena({ state, userId, children }: Props) {
  const mine = state.players.find((p) => p.userId === userId);
  const opp = state.players.find((p) => p.userId !== userId);

  return (
    <div className="sb-pk-arena">
      {/* 轻提示，不是遮罩：横屏更好用，但竖屏照样能玩——功能不能被提示挡住 */}
      <p className="sb-pk-rotate-tip">横屏体验更佳（竖屏也能玩）</p>
      <SideCard player={opp} label="对手" />
      <div className="sb-pk-arena-main">{children}</div>
      <SideCard player={mine} label="我" />
    </div>
  );
}
