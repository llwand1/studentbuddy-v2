/**
 * REST 契约：端点的请求/响应类型。routes 薄层与 web 的 api client 共用这一份。
 * M0 仅登记地基端点；M1 起按 SSE-CONTRACT.md「先登记再实现」扩容。
 */

export interface StatusResponse {
  /** 是否存在可用 provider（引导用户去设置页） */
  hasProviders: boolean;
  version: string;
}

export interface ApiError {
  error: string;
  detail?: string;
}
