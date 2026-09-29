/**
 * drill-prefs — 「等待时刷词」的本机偏好与当天战绩（`localStorage`，契约 `docs/WAIT-DRILL-SPEC.md` §6）。
 *
 * ★ 为什么放本机而不是服务端设置：三样东西都是**这台设备**的事——要不要自动弹、要不要出声、
 *   今天在这里斩了几个；跨设备同步它们没有意义，而每次开弹窗都多一个 GET 有代价。
 * ★ 「斩」掉的词条 id 只记**当天**（键里带日历日）：斩 = "今天不用再出"，不是"永远掌握"——
 *   永久性的记忆判断归复习引擎，不归一个等待时的小游戏。
 * ★ 全部读写 try/catch：隐私模式 / 配额满 / SSR 下 `localStorage` 不可用时静默退回默认值，
 *   刷词照常能玩，只是不记账（同 `lib/attribution.ts` 的口径）。
 */

export interface DrillPrefs {
  /** 发送后等回复时自动弹（默认开） */
  enabled: boolean;
  /** 音乐与音效（默认开；浏览器自动播放策略下首个点击后才会真的响） */
  sound: boolean;
}

export interface DrillDayStats {
  day: string;
  /** 今天斩掉（认识）的词条 id */
  slain: string[];
  /** 今天答对总数 */
  correct: number;
  /** 今天最高连击 */
  bestCombo: number;
  /** 今天借刷词打卡的到期词条数 */
  reviewed: number;
}

const PREFS_KEY = 'sb:drill:prefs';
const STATS_KEY = 'sb:drill:stats';

/** 偏好改了（设置页 ⇄ 弹窗里的音效钮）：`window` 上广播，常驻的 `WaitDrill` 跟着刷新 */
export const DRILL_PREFS_EVENT = 'sb:drill-prefs';
/** 手动打开刷词（等待气泡里的入口）：跨组件不传 props */
export const DRILL_OPEN_EVENT = 'sb:drill-open';

const DEFAULT_PREFS: DrillPrefs = { enabled: true, sound: true };

function store(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = store()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    store()?.setItem(key, JSON.stringify(value));
  } catch {
    /* 配额满 / 隐私模式：不记账，不报错 */
  }
}

export function loadDrillPrefs(): DrillPrefs {
  const v = readJson<Partial<DrillPrefs>>(PREFS_KEY);
  return {
    enabled: typeof v?.enabled === 'boolean' ? v.enabled : DEFAULT_PREFS.enabled,
    sound: typeof v?.sound === 'boolean' ? v.sound : DEFAULT_PREFS.sound,
  };
}

export function saveDrillPrefs(patch: Partial<DrillPrefs>): DrillPrefs {
  const next = { ...loadDrillPrefs(), ...patch };
  writeJson(PREFS_KEY, next);
  try {
    window.dispatchEvent(new CustomEvent(DRILL_PREFS_EVENT));
  } catch {
    /* 非浏览器环境 */
  }
  return next;
}

/** 等待气泡里的「刷词」入口调用：让常驻的 `WaitDrill` 立刻打开 */
export function requestDrillOpen(): void {
  try {
    window.dispatchEvent(new CustomEvent(DRILL_OPEN_EVENT));
  } catch {
    /* 非浏览器环境 */
  }
}

/** 当天战绩（换了日历日就是一张白纸） */
export function loadDrillStats(day: string): DrillDayStats {
  const v = readJson<Partial<DrillDayStats>>(STATS_KEY);
  if (!v || v.day !== day) return { day, slain: [], correct: 0, bestCombo: 0, reviewed: 0 };
  return {
    day,
    slain: Array.isArray(v.slain) ? v.slain.filter((x): x is string => typeof x === 'string') : [],
    correct: typeof v.correct === 'number' ? v.correct : 0,
    bestCombo: typeof v.bestCombo === 'number' ? v.bestCombo : 0,
    reviewed: typeof v.reviewed === 'number' ? v.reviewed : 0,
  };
}

export function saveDrillStats(stats: DrillDayStats): void {
  writeJson(STATS_KEY, stats);
}
