/**
 * api-sources —— 资料架的三个「读」接口（契约 docs/SOURCE-TRACE-SPEC.md §6 / §12 / §13）。
 *
 * 阅读页与 PDF 是 iframe 直接 `src` 出去的（见 `sources-store.readerUrl`），不走这里；这里是面板**自己发**的三种请求：
 *  - `probeReader`：挂 iframe 的同时问一句「这页会不会打不开 / 正文是不是太薄 / 服务器能不能截图」；
 *  - `shotUrl`：截图保底的 `<img src>`——由**顶层文档**加载而不是沙箱 iframe 里的页面加载，
 *    否则 `SameSite=Lax` 的会话 cookie 不会跟着去（沙箱文档是不透明源）；
 *  - `searchVideos`：视频线路，一次一条线路一个词。
 * 单独成文件是为了让面板组件保持「只认形状不认网络」（测试里整模块桩掉）。
 */
import type { VideoRoute, VideoRouteResult } from '@sb/shared';
import { request } from './api-request';

export interface ReaderProbe {
  ok: boolean;
  /** 失败时的 HTTP 语义码（415 非网页 / 502 取不到） */
  status?: number;
  reason?: string;
  /** 正文太薄（脚本渲染页）：阅读页有东西但多半不全 */
  thin: boolean;
  /** 服务器有没有可用的浏览器截图 */
  shot: boolean;
}

const qs = (sessionId: string, url: string, title?: string): string =>
  new URLSearchParams(title !== undefined ? { session: sessionId, url, title } : { session: sessionId, url }).toString();

export function probeReader(sessionId: string, url: string, title: string, signal?: AbortSignal): Promise<ReaderProbe> {
  return request<ReaderProbe>(`/api/sources/probe?${qs(sessionId, url, title)}`, { signal, timeoutMs: 30_000 });
}

export function shotUrl(sessionId: string, url: string): string {
  return `/api/sources/shot?${qs(sessionId, url)}`;
}

export function searchVideos(route: VideoRoute, query: string, signal?: AbortSignal): Promise<VideoRouteResult> {
  const q = new URLSearchParams({ route, q: query }).toString();
  return request<VideoRouteResult>(`/api/sources/videos?${q}`, { signal, timeoutMs: 25_000 });
}
