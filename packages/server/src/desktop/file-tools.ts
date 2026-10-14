import type { ToolDefinition } from '../llm/types.js';
import { listComputerFiles, readComputerFile, writeWorkspaceFile } from './files.js';
import { workspaceInfo } from './file-policy.js';
import type { FileContext } from './file-approvals.js';
import { validateToolArgs } from '../chat/tools/schema.js';
const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const pathProperty = { type: 'string', description: '工作区内可用相对路径；电脑其他位置只读，需绝对路径。' };
const definitions = [
  definition('desktop_workspace', '核对已接入的本机文件能力，返回真实工作区、桌面等目录和权限；不读取文件、不更改授权。能力问题先查此工具，不从网络猜测。', {}, []),
  definition('list_files', '列出目录前 200 项，不递归扫描。敏感目录须等待用户许可。', { path: pathProperty }, ['path']),
  definition('read_file', '读取文本文件（最多 256KB，超限标注截断）。敏感路径或正文先等待用户许可，不向模型返回未经许可的内容。', { path: pathProperty }, ['path']),
  definition('write_file', '仅在工作区内创建或覆盖 UTF-8 文本文件；覆盖前自动备份。工作区外禁止写入，不运行程序，不删除文件。', { path: pathProperty, content: { type: 'string' } }, ['path', 'content']),
];
export function desktopFileDefinitions(): ToolDefinition[] { return definitions; }
export async function executeFileTool(name: string, argsJson: string, ctx: FileContext): Promise<string> {
  const tool = definitions.find(d => d.function.name === name);
  if (!tool) throw new Error('该子 Agent 无权调用此工具');
  const args = JSON.parse(argsJson) as Record<string, unknown>, invalid = validateToolArgs(name, args, tool.function.parameters);
  if (invalid) throw new Error(invalid);
  if (name === 'desktop_workspace') return JSON.stringify(workspaceInfo(ctx.owner));
  const input = String(args.path);
  if (name === 'list_files') {
    const all = await listComputerFiles(ctx, input), entries = [] as typeof all;
    for (const entry of all) { if (JSON.stringify([...entries, entry]).length > 12000) break; entries.push(entry); }
    return JSON.stringify({ entries, truncated: entries.length < all.length || all.length === 200, note: '单目录最多 200 项，不递归' });
  }
  if (name === 'read_file') {
    const file = await readComputerFile(ctx, input);
    let result = JSON.stringify(file);
    while (result.length > 13000 && file.text.length) { file.text = file.text.slice(0, Math.floor(file.text.length / 2)); file.truncated = true; result = JSON.stringify(file); }
    return result;
  }
  return JSON.stringify(await writeWorkspaceFile(ctx, input, String(args.content)));
}
