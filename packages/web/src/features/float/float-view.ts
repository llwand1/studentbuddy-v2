/**
 * float-view — 桌面悬浮球（吉祥物）的纯逻辑层（契约 docs/DESKTOP-SPEC.md「桌面悬浮球」）。
 *
 * ★ 为什么单独成文件：与宿主（C#）的**消息协议**是这里唯一有内容的逻辑，而它是跨语言契约 ——
 *   两边各实现一半，常量写在两处就有漂移风险，故钉在一处、并让测试看着它们。
 *   表现层（吉祥物本体）由 `Mascot` 组件与 float.css 承担，没有需要单测的纯逻辑。
 * ★ 普通浏览器直接开 `#/float` 时 `window.chrome.webview` 不存在 —— 全部静默降级为无操作。
 */

// 球被 WinForms 宿主包着；「拖窗口 / 展开成手机小屏 / 收成球」这三件事网页里做不到
// （网页改不了 OS 窗口的位置与尺寸），只能请宿主代做。
export const HOST_DRAG = 'sb-float:drag';
export const HOST_EXPAND = 'sb-float:expand';
export const HOST_COLLAPSE = 'sb-float:collapse';
/**
 * 宿主 → 网页：刚才那次按下**没有挪动窗口**，也就是「点一下」而不是「拖一把」。
 * ★ 为什么要把这个判断放在宿主：WebView2 在按住不放时不派发 pointermove（实机实测），
 *   网页侧没有「位移」可看；而宿主跑完系统移动循环后能直接比对窗口位置 —— 那个信号是可靠的。
 */
export const HOST_TAP = 'sb-float:tap';

interface HostBridge {
  postMessage: (message: string) => void;
}

/** 取出宿主桥；不在宿主里（普通浏览器 / 测试的 node 环境）时返回 undefined */
function hostBridge(): HostBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const chrome = (window as unknown as { chrome?: { webview?: HostBridge } }).chrome;
  return chrome?.webview;
}

/** 给宿主发一条消息；没有宿主时静默忽略（不让「用浏览器打开」变成报错） */
export function postToHost(message: string): void {
  try {
    hostBridge()?.postMessage(message);
  } catch {
    /* 宿主桥异常（跨域限制等）：忽略——球的核心是展示与入口，不该因此白屏 */
  }
}

/** 现在是不是跑在桌面宿主里（普通浏览器为 false）。用来决定「点击」这类动作由谁负责。 */
export function hasHost(): boolean {
  return hostBridge() !== undefined;
}

interface HostInbox {
  addEventListener: (type: string, handler: (event: { data: unknown }) => void) => void;
  removeEventListener: (type: string, handler: (event: { data: unknown }) => void) => void;
}

/** 订阅宿主发来的消息（目前只有 HOST_TAP）；不在宿主里时不订阅，返回一个空操作 */
export function onHostMessage(handler: (message: string) => void): () => void {
  const bridge = hostBridge() as unknown as (HostBridge & Partial<HostInbox>) | undefined;
  const add = bridge?.addEventListener;
  const remove = bridge?.removeEventListener;
  if (!bridge || !add || !remove) return () => undefined;
  const listener = (event: { data: unknown }): void => {
    if (typeof event.data === 'string') handler(event.data);
  };
  add.call(bridge, 'message', listener);
  return () => remove.call(bridge, 'message', listener);
}