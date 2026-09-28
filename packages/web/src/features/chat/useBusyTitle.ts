/**
 * useBusyTitle —— 生成中把状态写进标签页标题。
 *
 * 长回答（带工具、带思考）常常是切到别的标签去等：标题带「● 回复中」才知道它还在跑；
 * 回答落成时若标签页不在前台，标题换成「✓ 回答完成」直到用户切回来再复原——
 * 只改标题，不发系统通知、不响铃（那是要用户授权的事，学习场景里也过重）。
 *
 * 口径：
 * · 只在「忙过」之后才动标题，初次挂载／始终不忙不碰它（别的页面可能正在改标题）。
 * · 基准标题在进入忙态那一刻记下（剥掉本 hook 自己加过的前缀，防叠字）。
 * · 卸载或再次进入忙态时，先把上一段「完成」态清掉再写新的。
 */
import { useEffect, useRef } from 'react';

export const BUSY_PREFIX = '● 回复中 · ';
export const DONE_PREFIX = '✓ 回答完成 · ';

/** 去掉本 hook 加过的前缀（无论哪一种），拿到裸标题 */
export function stripTitlePrefix(title: string): string {
  for (const p of [BUSY_PREFIX, DONE_PREFIX]) if (title.startsWith(p)) return title.slice(p.length);
  return title;
}

export function useBusyTitle(busy: boolean): void {
  const wasBusy = useRef(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (busy) {
      const base = stripTitlePrefix(document.title);
      wasBusy.current = true;
      document.title = BUSY_PREFIX + base;
      // 忙态中途卸载（切页）：不能把「回复中」留在别的页面的标题上
      return () => {
        document.title = base;
      };
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    const base = stripTitlePrefix(document.title);
    if (!document.hidden) {
      document.title = base;
      return;
    }
    document.title = DONE_PREFIX + base;
    const restore = (): void => {
      if (document.hidden) return;
      document.title = base;
      document.removeEventListener('visibilitychange', restore);
    };
    document.addEventListener('visibilitychange', restore);
    return () => {
      document.removeEventListener('visibilitychange', restore);
      document.title = base;
    };
  }, [busy]);
}
