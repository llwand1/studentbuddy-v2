import type { ChatOptions } from '../chat/options.js';
import { desktopEnabled } from './file-policy.js';

export function isDesktopFileRequest(text: string): boolean {
  return /桌面|工作区|本机|本地文件|电脑.{0,8}(?:文件|屏幕|权限)|文件夹|[a-z]:[\\/]/i.test(text)
    && /读取|打开|列出|查看|浏览|保存|写入|创建|生成|访问|文件|目录|看(?:到|见)|能否|可以|权限/.test(text);
}
/** Online mode must not substitute web guesses for actual local capability facts. */
export function desktopOpeningMode(opts: ChatOptions, text: string): 'files' | 'image' | null {
  if (!desktopEnabled() || opts.grillMe) return null;
  if (isDesktopFileRequest(text)) return 'files';
  return opts.images?.length ? 'image' : null;
}
export const DESKTOP_RUNTIME_FACTS = `当前是 StudentBuddy 本机桌面安装版，回环服务执行文件工具。模型可能托管在远端，但本机工具已经接入，不能因此把 StudentBuddy 工具执行环境误说成隔离服务器，或声称与电脑只有文字通道、完全没有文件权限。
desktop_workspace 返回当前真实工作区、桌面目录与权限；list_files / read_file 可按用户任务读取电脑普通文件，write_file 仅写工作区。能力问题先查询 desktop_workspace，不用网页搜索猜测。
桌面文件与屏幕画面是两回事：可以按需列出/读取桌面文件，但不会持续看到屏幕。用户可主动通过悬浮球的“截图提问”框选画面，预览后点击发送；未发送的截图不交给模型。
不要把旧回答中“没有本机文件工具”的说法当成当前事实；不要声称看过没有实际读取的文件或没有收到的截图。`;
