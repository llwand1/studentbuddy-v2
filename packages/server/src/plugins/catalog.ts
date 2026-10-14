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

