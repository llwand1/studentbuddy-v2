/**
 * reading-prefs — 阅读区字号的本机偏好（`localStorage`，契约 `docs/READING-SIZE-SPEC.md`）。
 *
 * ★ 为什么只缩「阅读区」而不是整个应用：这套界面是像素风，导航 / 卡牌 / 知识大陆的地块都是
 *   按固定网格排的，整体放大会把布局撑破（地块错位、卡墙换行、胶囊压住正文）。
 *   真正「字小看不清」的是**要逐字读的那两处**：对话正文与词条释义——所以只缩这两处。
 *   实现上不是给每个字号加一条规则，而是在阅读区容器上**重新定义 `--sb-fs-*` 这组 token**
 *   （见 `styles/reading.css`）：markdown.css 本来就全走 token，于是标题、代码、表格、脚注
 *   一起按比例变大，版面关系不走样。
 *
 * ★ 为什么存本机而不是服务端设置：字号是**这块屏幕**的事（台式机 27 寸和笔记本 13 寸要的不一样），
 *   跨设备同步它反而是打扰；而且它必须在首帧之前生效，多等一个 GET 会闪一下。
 *   同 `drill-prefs.ts` 的口径，读写全 try/catch，隐私模式下静默退回默认。
 *
 * ★ 单一事实源：档位表 `READING_SIZES` 既是 UI 的渲染源，也是 CSS 里 `:root[data-reading=…]`
 *   的键集合——加一档只改这里和 `reading.css` 一行，不会有第三处要同步。
 */

/** 档位 id；与 `styles/reading.css` 里的 `:root[data-reading='…']` 一一对应 */
export type ReadingSize = 's' | 'm' | 'l' | 'xl';

export interface ReadingSizeOption {
  id: ReadingSize;
  label: string;
  /** 给设置页显示的实际正文像素（＝14px × 缩放比，四舍五入），让人知道自己在选什么 */
  px: number;
}

/** 四档；`m` 是出厂值（＝改动前的 14px，老用户升级后一个像素都不变） */
export const READING_SIZES: readonly ReadingSizeOption[] = [
  { id: 's', label: '小', px: 13 },
  { id: 'm', label: '标准', px: 14 },
  { id: 'l', label: '大', px: 16 },
  { id: 'xl', label: '特大', px: 18 },
];

export const DEFAULT_READING_SIZE: ReadingSize = 'm';

const KEY = 'sb:reading:size';

/** 字号改了：`window` 上广播，设置页之外的订阅者（若有）跟着刷新 */
export const READING_SIZE_EVENT = 'sb:reading-size';

function store(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** 未知值（手改 localStorage / 旧版本遗留）一律按默认档，不让界面进入没有样式的状态 */
export function normalizeReadingSize(v: unknown): ReadingSize {
  return READING_SIZES.some((o) => o.id === v) ? (v as ReadingSize) : DEFAULT_READING_SIZE;
}

export function loadReadingSize(): ReadingSize {
  try {
    return normalizeReadingSize(store()?.getItem(KEY));
  } catch {
    return DEFAULT_READING_SIZE;
  }
}

/**
 * 写进 `<html data-reading="…">`。CSS 只认这一个属性 ⇒ 「当前字号」在 DOM 上只有一个事实源，
 * 不会出现「store 说 l、页面显示 m」。默认档也显式写上：便于排查时一眼看出它生效了。
 */
export function applyReadingSize(size: ReadingSize): void {
  try {
    if (typeof document !== 'undefined') document.documentElement.dataset.reading = size;
  } catch {
    /* SSR / 无 DOM：静默跳过，样式退回 :root 的缺省比例 1 */
  }
}

/** 存 + 落 DOM + 广播，返回归一化后的值（调用方直接拿它 setState，不必自己再归一） */
export function saveReadingSize(size: ReadingSize): ReadingSize {
  const next = normalizeReadingSize(size);
  try {
    store()?.setItem(KEY, next);
  } catch {
    /* 配额满 / 隐私模式：这一次不记账，但本次会话内仍然生效（下面照样落 DOM） */
  }
  applyReadingSize(next);
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(READING_SIZE_EVENT));
  } catch {
    /* 事件派发失败不影响已经生效的样式 */
  }
  return next;
}

/** 应用启动时调一次：在首帧之前把属性写上，避免「先小后大」地闪一下 */
export function initReadingSize(): ReadingSize {
  const size = loadReadingSize();
  applyReadingSize(size);
  return size;
}
