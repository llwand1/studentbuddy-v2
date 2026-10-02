/**
 * api-doc — 文档模式的前端读写口（契约 `docs/DOC-RAG-SPEC.md` §5 / §10）。
 *
 * 单开文件的原因同 api-tools / api-auth / api-terms-domain：2026-10-02 加网页资料
 * （`setFromUrl` + `DocSource`）后 `api.ts` 撞 400 行红线，按仓规**拆文件不压注释**。
 * `api.ts` 只留 `doc: docApi` 一处引用，调用方（`useDocMode` / `SaveAsDocButton`）零改动。
 *
 * 四个接口的共同口径：**只过元信息，正文永不回显**——长资料没必要反复过网络，
 * 也不该让「取一次状态」顺带把 60k 正文搬回前端。正文只在写入时上行一次。
 */
import { request } from './api-request.js';

export interface DocMeta {
  name: string;
  chars: number;
  truncated: boolean;
}

/** 网页资料的出处回执（§10.5）：只有元信息，不含正文 */
export interface DocSource {
  url: string;
  title: string;
  site: string;
  /** 网页正文原始字数（**截断前**）——截了多少要说得出来（ADR-5） */
  sourceChars: number;
  /** 是否因超出单份资料上限（`DOC_URL_MAX_CHARS`）被截 */
  clipped: boolean;
}

/** 文档模式：会话绑定一篇资料，每次一份，载入新的即替换当前的 */
export const docApi = {
  get: (sessionId: string) => request<{ doc: DocMeta | null }>(`/api/doc?sessionId=${encodeURIComponent(sessionId)}`),

  set: (sessionId: string, name: string, text: string) =>
    request<{ doc: DocMeta }>('/api/doc', {
      method: 'POST',
      body: JSON.stringify({ sessionId, name, text }),
    }),

  /**
   * 网页资料（§10）：给网址，**服务端**抓正文并落成本会话资料。
   *
   * 前端不自己抓，两个理由：① 浏览器跨源抓不到绝大多数站点；② 真抓得到也不该信——
   * 那等于前端可以往会话资料里塞任意正文并声称它来自某个网址。
   */
  setFromUrl: (sessionId: string, url: string) =>
    request<{ doc: DocMeta; source: DocSource }>('/api/doc/url', {
      method: 'POST',
      body: JSON.stringify({ sessionId, url }),
    }),

  clear: (sessionId: string) =>
    request<{ ok: boolean }>(`/api/doc?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
};
