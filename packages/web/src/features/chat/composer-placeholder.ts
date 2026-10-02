/**
 * composer-placeholder — 输入框占位文案的唯一出处（契约 docs/MOBILE-SPEC.md §3.1）。
 * 桌面版把快捷键写全（Enter / Shift+Enter / 粘贴图片）；手机没有物理键盘也不常粘贴，长文案在 390px 宽上占两行、
 * 还会和「联网已开」按钮挤在一起 ⇒ 手机只留一句话。状态优先级（开新对话中 > 生成中 > 未就绪）两端一致。
 */
export interface PlaceholderFacts {
  sessionId: string | null;
  blocked: boolean;
  busy: boolean;
  narrow: boolean;
}

export function composerPlaceholder(f: PlaceholderFacts): string {
  if (f.sessionId === null) {
    if (f.blocked) return '正在开新对话…';
    return f.narrow ? '问点什么，发送就开一个新对话' : '问点什么，发送就会开一个新对话（Enter 发送 / Shift+Enter 换行，可直接粘贴图片）';
  }
  if (f.blocked) return f.busy ? '生成中…（Esc 停止）' : '连接未就绪…';
  return f.narrow ? '问点什么…' : '问点什么（Enter 发送 / Shift+Enter 换行，可直接粘贴图片）';
}
