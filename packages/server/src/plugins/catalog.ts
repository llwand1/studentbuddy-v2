import type { PluginManifest } from '@sb/shared';
/** Maintained allowlist, not server-provided annotations. */
export const GITHUB_TOOLS = [
  'get_file_contents', 'list_branches', 'list_commits', 'get_commit',
  'list_issues', 'issue_read', 'list_pull_requests', 'pull_request_read', 'actions_list', 'actions_get',
];
export const GITHUB_PLUGIN: PluginManifest = {
  schemaVersion: 1, id: 'github', name: 'GitHub', version: '1.0.0',
  description: '读取明确选择的 GitHub 仓库、代码、Issue、PR 和 Actions；不开放写操作。',
  transport: 'streamable-http', endpoint: 'https://api.githubcopilot.com/mcp/', tools: GITHUB_TOOLS,
};
export const BILIBILI_PLUGIN: PluginManifest = {
  schemaVersion: 1, id: 'bilibili', name: 'B站学习', version: '1.0.0',
  description: '按学习方向推荐公开视频与资料，用视频简介、共读划选或学习笔记出题；不访问账号历史。',
  transport: 'builtin', endpoint: 'https://www.bilibili.com/',
  tools: ['recommend_videos', 'select_video', 'quiz_from_video'],
};
export const BUILTIN_PLUGINS: Readonly<Record<string, PluginManifest>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, PluginManifest>, { github: GITHUB_PLUGIN, bilibili: BILIBILI_PLUGIN }),
);

