/**
 * pk — AI 出题 PK 契约类型（docs/PK-SPEC.md，先登记再实现）。
 *
 * P0-1 只落登录：账号 = 服务端 pk_users 表一条记录；
 * openid 为 P0 模拟值（mock_<userId>），P1 换真微信网页授权时响应结构不变、前端零改动。
 * 房间 / 对战 / SSE 事件类型随 P0-2 在本文件追加登记。
 */

/** 登录身份（POST /api/pk/auth/login 响应 / GET /api/pk/auth/me 响应主体） */
export interface PkIdentity {
  userId: string;
  /** P0 = `mock_<userId>`；P1 替换为微信公众号网页授权真实 openid */
  openid: string;
  /** 昵称（1~20 字，trim 后非空），登录时可改名 */
  nickname: string;
}
