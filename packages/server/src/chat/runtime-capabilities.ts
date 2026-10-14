/** Owner-scoped runtime capabilities, assembled once without changing the built-in registry. */
import type { ChatMessage, ToolDefinition } from '../llm/types.js';
import { desktopChatDefinitions, DESKTOP_FILE_TOOL_NAMES, applyDesktopBoundary, desktopBoundaryTokens } from '../desktop/chat-integration.js';
import { pluginChatDefinitions, applyPluginBoundary, pluginBoundaryTokens } from '../plugins/chat.js';
import { EXAM_DISCOVERY } from './exam-resource-discovery.js';
import { wantsExamDiscovery } from './exam-scope-action.js';
import { LEARNING_VIDEO_TOOLS } from './learning-video-tools.js';
export { wantsExamDiscovery } from './exam-scope-action.js';
export function runtimeDefinitions(owner: string | null, text = ''): ToolDefinition[] {
  return [...LEARNING_VIDEO_TOOLS, ...desktopChatDefinitions(), ...pluginChatDefinitions(owner), ...(wantsExamDiscovery(text) ? [EXAM_DISCOVERY] : [])];
}
export function runtimeBoundaryTokens(tools: ToolDefinition[]): number {
  return desktopBoundaryTokens() + pluginBoundaryTokens(tools);
}
export function applyRuntimeBoundary(messages: ChatMessage[], tools: ToolDefinition[]): void {
  applyDesktopBoundary(messages); applyPluginBoundary(messages,tools);
}
export const RUNTIME_NO_TIMEOUT = ['ask_choice','plugin_call', ...DESKTOP_FILE_TOOL_NAMES];

