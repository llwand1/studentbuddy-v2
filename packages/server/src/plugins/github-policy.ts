import { GITHUB_TOOLS } from './catalog.js';
const METHODS: Record<string, readonly string[]> = {
  issue_read: ['get', 'get_comments', 'get_sub_issues', 'get_labels'],
  pull_request_read: ['get', 'get_diff', 'get_files', 'get_commits', 'get_comments', 'get_reviews', 'get_review_comments', 'get_status'],
  actions_list: ['list_workflows', 'list_workflow_runs', 'list_workflow_jobs', 'list_workflow_run_artifacts'],
  actions_get: ['get_workflow', 'get_workflow_run', 'get_workflow_job', 'get_workflow_run_usage'],
};
export function enforceGithubRead(tool: string, args: Record<string, unknown>, repositories: string[]): void {
  if (!GITHUB_TOOLS.includes(tool)) throw new Error('GitHub 首版仅允许维护的只读工具');
  if (typeof args.owner !== 'string' || typeof args.repo !== 'string' ||
      !repositories.includes(`${args.owner}/${args.repo}`.toLowerCase())) throw new Error('该仓库不在插件授权范围内，请在设置 → 插件中明确添加');
  const methods = METHODS[tool];
  if (methods && (typeof args.method !== 'string' || !methods.includes(args.method))) throw new Error('该 method 未被批准为 GitHub 只读操作');
  // Repo identity checks alone cannot authorize URI path traversal in a downstream API client.
  for (const key of ['path','sha','resource_id']) {
    const value = args[key];
    if (typeof value === 'string' && (value.length > 4096 || value.startsWith('/') ||
        /[%?#:\\]/u.test(value) || value.split('/').some(s => s === '..' || s === '.') ||
        [...value].some(c => c.charCodeAt(0) < 32))) throw new Error('请使用仓库内未转义的相对路径或标识，不能包含 URL、父目录或控制字符');
  }
  // Do not let opaque future parameters expand scope; schema validates the rest.
  for (const k of ['perPage','per_page','page']) {
    if (args[k] !== undefined && (typeof args[k] !== 'number' || !Number.isInteger(args[k]) ||
        (args[k] as number) < 1 || (args[k] as number) > (k === 'page' ? 1000 : 100))) throw new Error('分页参数超出允许范围');
  }
}

