/**
 * pk-view — PK 页面纯逻辑（契约 docs/PK-SPEC.md §5）。
 *
 * 判定逻辑一律放这里、组件只负责挂——本仓 .tsx 无测试环境（先例 doc-name.ts），
 * 纯函数才能进测链路。全部无副作用、无时钟依赖：now 一律由调用方传入。
 */
import { PK_ROOM_CODE_LEN, type PkRoomState } from '@sb/shared';

/** 房号输入归一：只留数字、截到 6 位（contract §2.1 roomCode = 6 位数字） */
export function normalizeRoomCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, PK_ROOM_CODE_LEN);
}

/** 对局时钟剩余毫秒：已到点钳 0（客户端时间只作展示，真判罚在服务端） */
export function remainingMs(endsAt: number, now: number): number {
  return Math.max(0, endsAt - now);
}

/** 对局时钟 mm:ss（例 7:35）；一局上限 8 分钟，不会出现小时位 */
export function formatClock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 我在房内的下标；不在房内返回 -1（房主恒为 players[0]，契约 §2.1） */
export function myIndex(state: PkRoomState, userId: string): number {
  return state.players.findIndex((p) => p.userId === userId);
}

/** 我是不是房主（唯一有权开局的人） */
export function isOwner(state: PkRoomState, userId: string): boolean {
  return myIndex(state, userId) === 0;
}
