/**
 * PkTopicBar — 当前轮次主题条（P0-7）。
 *
 * 主题在双方各自选定的主题之间交替，**谁出题都要贴合它**。
 * 这一条存在的意义：它是玩家判断「我现在该不该出题 / 我该往哪个方向出」的唯一依据，
 * 没有它，跑题判失败就成了无预警的惩罚。
 */
import type { PkRoomState } from '@sb/shared';
import { topicOwnerLabel } from './pk-view';

interface Props {
  state: PkRoomState;
  userId: string;
}

export function PkTopicBar({ state, userId }: Props) {
  if (!state.currentTopic) return null;
  return (
    <div className="sb-pk-topic">
      <span className="sb-pk-topic-label">本轮主题</span>
      <span className="sb-pk-topic-name">{state.currentTopic}</span>
      <span className="sb-pk-topic-owner">{topicOwnerLabel(state, userId)}</span>
    </div>
  );
}
