import type { DesktopCapability, DesktopFileApproval, DesktopFileEntry, DesktopFileText, DesktopRun, DesktopRunEvent, DesktopWorkspaceInfo } from '@sb/shared';
import { request } from '../../lib/api-request';
export interface WorkbenchState {
  workspace: DesktopWorkspaceInfo;
  runs: DesktopRun[];
  approvals: DesktopFileApproval[];
  jobs: Array<{ id: string; label: string; status: string; attempts: number; error: string | null }>;
  jobCounts: Record<string, number>;
}
const base = '/api/desktop/workbench';
const post = <T,>(path: string, body: unknown, timeoutMs = 8000) => request<T>(base + path, { method: 'POST', body: JSON.stringify(body), timeoutMs });
export const workbenchApi = {
  state: () => request<WorkbenchState>(base + '/state', { timeoutMs: 8000 }),
  create: (prompt: string, capability: DesktopCapability) => post<DesktopRun>('/tasks', { prompt, capability }),
  detail: (id: string) => request<{ run: DesktopRun; events: DesktopRunEvent[] }>(base + `/tasks/${encodeURIComponent(id)}`),
  cancel: (id: string) => post(`/tasks/${encodeURIComponent(id)}/cancel`, {}),
  retry: (id: string) => post<DesktopRun>(`/tasks/${encodeURIComponent(id)}/retry`, {}),
  retryJob: (id: string) => request(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' }),
  approve: (id: string, allow: boolean) => post(`/approvals/${encodeURIComponent(id)}`, { allow }),
  workspace: (path: string) => request<DesktopWorkspaceInfo>(base + '/workspace', { method: 'PUT', body: JSON.stringify({ path }) }),
  protect: (path: string, protect: boolean) => post<DesktopWorkspaceInfo>('/protected-paths', { path, protect }),
  list: (path: string) => post<DesktopFileEntry[]>('/files/list', { path }, 310000),
  read: (path: string) => post<DesktopFileText>('/files/read', { path }, 310000),
  write: (path: string, content: string) => post<{ path: string; bytes: number; backup: boolean }>('/files/write', { path, content }, 310000),
};
