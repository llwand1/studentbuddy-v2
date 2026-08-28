/**
 * 内置浏览器面板的状态件：HtmlCard 在对话流深处触发，面板在应用壳右侧渲染，
 * 用微型外部 store + useSyncExternalStore 跨层，省掉 provider 穿层也便于单测。
 *
 * 面板只挂 /api/preview/:id 这类服务端沙箱文档，不提供地址栏——它不是通用浏览器。
 */
export interface PreviewTarget {
  url: string;
  label: string;
  /** 刷新计数：url 不变时靠它换 iframe key 强制重载 */
  nonce: number;
}

let current: PreviewTarget | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribePreview(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 快照必须引用稳定（同一次状态返回同一对象），否则 useSyncExternalStore 会死循环 */
export function getPreview(): PreviewTarget | null {
  return current;
}

/** 打开/切换预览：同一份内容重复点也重载一次（模型可能已把上文那段改写又点） */
export function openPreview(url: string, label: string): void {
  const prev = current;
  current = { url, label, nonce: prev !== null && prev.url === url ? prev.nonce + 1 : 0 };
  emit();
}

export function refreshPreview(): void {
  if (current === null) return;
  current = { ...current, nonce: current.nonce + 1 };
  emit();
}

export function closePreview(): void {
  if (current === null) return;
  current = null;
  emit();
}
