/**
 * guide-prefs —— 引路灯的两个本机偏好（契约 `docs/GUIDE-SPEC.md` §8「主动程度」）。
 *
 * · `sb_guide_seen`：本机自动展开过一次就置 1，此后**永不**自动展开；
 * · `sb_guide_proactive`：弹层页脚「主动提示」开关，`0` ＝ 静默（不点亮、不冒提示、不自动展开）。
 *
 * ★ 存不进去（隐私模式等）不报错：`seen` 退回进程内变量（本次页面存活期内不再自动展开），
 *   `proactive` 退回内存值（本次会话内切换照常生效）——同 `landing-lang` 对 localStorage 的处理。
 */
export const GUIDE_SEEN_KEY = 'sb_guide_seen';
export const GUIDE_PROACTIVE_KEY = 'sb_guide_proactive';

let seenInMemory = false;
let proactiveInMemory: boolean | null = null;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 存不进去：退回进程内变量，见文件头 */
  }
}

export const readGuideSeen = (): boolean => seenInMemory || read(GUIDE_SEEN_KEY) === '1';

export function markGuideSeen(): void {
  seenInMemory = true;
  write(GUIDE_SEEN_KEY, '1');
}

export function readGuideProactive(): boolean {
  if (proactiveInMemory !== null) return proactiveInMemory;
  return read(GUIDE_PROACTIVE_KEY) !== '0';
}

export function writeGuideProactive(on: boolean): void {
  proactiveInMemory = on;
  write(GUIDE_PROACTIVE_KEY, on ? '1' : '0');
}

/** 测试用 */
export function resetGuidePrefs(): void {
  seenInMemory = false;
  proactiveInMemory = null;
}
