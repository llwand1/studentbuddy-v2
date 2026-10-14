import type { TaskItem } from './task-list.js';

export type DesktopRunStatus = 'queued' | 'running' | 'waiting_permission' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type DesktopCapability = 'read_only' | 'workspace_write';
export interface DesktopRun {
  id: string;
  parentId: string | null;
  sessionId: string | null;
  kind: 'chat' | 'agent' | 'quiz';
  title: string;
  prompt: string;
  capability: DesktopCapability;
  status: DesktopRunStatus;
  stage: string;
  model: string;
  tasks: TaskItem[];
  result: string;
  error: string;
  createdAt: number;
  updatedAt: number;
}
export interface DesktopFileApproval {
  id: string;
  runId: string | null;
  path: string;
  operation: 'read' | 'write' | 'list';
  reason: string;
  status: 'pending' | 'allowed' | 'denied' | 'expired';
  expiresAt: number;
}
export interface DesktopRunEvent { id: number; summary: string; createdAt: number; }
export interface DesktopWorkspaceInfo {
  root: string;
  locations?: { desktop: string; documents: string; downloads: string };
  protectedPaths: string[];
  computerAccess: 'read_only';
  workspaceAccess: 'read_write';
  sensitiveAccess: 'ask_once';
}
export interface DesktopFileEntry { name: string; path: string; directory: boolean; sensitive: boolean; }
export interface DesktopFileText { path: string; text: string; bytes: number; truncated: boolean; }
export const DESKTOP_ACTIVE_STATUSES: readonly DesktopRunStatus[] = ['queued', 'running', 'waiting_permission'];
