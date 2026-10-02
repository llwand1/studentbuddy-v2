/**
 * shared/pomodoro — 番茄钟 × 学习方向的**唯一事实源**（契约 `docs/POMODORO-SPEC.md`）。
 *
 * 番茄钟在本仓不是一个倒计时玩具：它回答的是「**接下来这段时间我在学什么**」。用户在复习列表里定下
 * 「数学 · 30 分钟」，这 30 分钟里对话、出题、刷词、引路灯都要**偏向数学**——所以「现在有没有方向、
 * 方向是什么、还剩几分钟」必须前后端同一个答案，纯函数、零 IO、零时钟（`now` 一律由调用方传入）。
 *
 * ★ 三条硬口径（改码前必读）：
 *  1. **方向只在工作段生效**：休息段不是「学数学」，所有偏向都退回常态（`pomodoroFocus` 休息段返回 null）。
 *  2. **到点不自动翻页**：工作段到时只是「可以休息了」，是否休息 / 再来一轮 / 结束由用户在提醒上点——
 *     定时器替人做决定会把一次专注变成被追着跑；所以 `remainingMs` 可以是 0 而 `phase` 仍是 `work`。
 *  3. **纯派生、不记第二套账**：今天完成几轮只看 `completed`，长休与否只看 `round % 4`，没有别的字段能改它们。
 */
export const SETTING_KEY_POMODORO = 'pomodoro';

/** 工作段常用时长（分钟）；用户也可以自己敲 */
export const POMODORO_WORK_PRESETS: readonly number[] = [25, 30, 45, 60];
export const POMODORO_DEFAULT_WORK_MIN = 25;
export const POMODORO_WORK_MIN = 5;
export const POMODORO_WORK_MAX = 180;
/** 短休 / 长休（分钟）；每 `POMODORO_SET_ROUNDS` 轮后一次长休 */
export const POMODORO_BREAK_MIN = 5;
export const POMODORO_LONG_BREAK_MIN = 15;
export const POMODORO_SET_ROUNDS = 4;
/** 学习方向字数上限（它会进提示词、进胶囊、进引路灯——写成一句话就没法摆） */
export const POMODORO_SUBJECT_MAX = 24;
/** 「还没设番茄钟」的提醒：打开应用多久后才敲、两次之间隔多久（本机记，不进库） */
export const POMODORO_SETUP_NUDGE_DELAY_MS = 3 * 60 * 1000;
export const POMODORO_SETUP_NUDGE_COOLDOWN_MS = 2 * 60 * 60 * 1000;
/** 工作段剩这么多分钟以内，引路灯 / 胶囊的文案改说「快到了」 */
export const POMODORO_ENDING_MIN = 3;

export type PomodoroPhase = 'work' | 'break';

export interface PomodoroSession {
  /** 学习方向：一个词或短语（「数学」「高数·极限」），进提示词时原样引用 */
  subject: string;
  workMin: number;
  breakMin: number;
  /** 第几轮工作段（从 1 起） */
  round: number;
  phase: PomodoroPhase;
  /** 当前段开始 / 应结束的时刻（ISO） */
  phaseStartedAt: string;
  phaseEndsAt: string;
  /** 整个番茄钟开始的时刻（ISO） */
  startedAt: string;
  /** 已完成的工作段数（本次番茄钟内） */
  completed: number;
}

/** 偏向各功能用的「当前方向」：只在工作段存在 */
export interface PomodoroFocus {
  subject: string;
  /** 剩余分钟（向上取整，到点为 0） */
  leftMin: number;
  round: number;
}

const toInt = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);
const isoOf = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** 学习方向归一：去控制字符、压空白、截到上限；空串 ⇒ null（没方向就不该开钟） */
export function normalizePomodoroSubject(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- 剔除控制字符
  const flat = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  return chars.length > POMODORO_SUBJECT_MAX ? chars.slice(0, POMODORO_SUBJECT_MAX).join('') : flat;
}

export function normalizeWorkMin(v: unknown): number {
  const n = toInt(v);
  return n === null ? POMODORO_DEFAULT_WORK_MIN : clamp(n, POMODORO_WORK_MIN, POMODORO_WORK_MAX);
}

/** 一整份会话的归一：形状不对 / 方向为空 / 时间坏 ⇒ null（库里的坏值当「没开钟」） */
export function normalizePomodoro(input: unknown): PomodoroSession | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const subject = normalizePomodoroSubject(o.subject);
  const phaseStartedAt = isoOf(o.phaseStartedAt);
  const phaseEndsAt = isoOf(o.phaseEndsAt);
  const startedAt = isoOf(o.startedAt) ?? phaseStartedAt;
  if (!subject || !phaseStartedAt || !phaseEndsAt || !startedAt) return null;
  const phase: PomodoroPhase = o.phase === 'break' ? 'break' : 'work';
  const round = Math.max(1, toInt(o.round) ?? 1);
  return {
    subject,
    workMin: normalizeWorkMin(o.workMin),
    breakMin: clamp(toInt(o.breakMin) ?? POMODORO_BREAK_MIN, 1, 60),
    round,
    phase,
    phaseStartedAt,
    phaseEndsAt,
    startedAt,
    completed: Math.max(0, toInt(o.completed) ?? 0),
  };
}

const plusMin = (iso: string, min: number): string => new Date(Date.parse(iso) + min * 60_000).toISOString();

/** 开一个新番茄钟（第 1 轮工作段） */
export function startPomodoro(input: { subject: string; workMin?: number; breakMin?: number }, now: Date): PomodoroSession | null {
  const subject = normalizePomodoroSubject(input.subject);
  if (!subject) return null;
  const workMin = normalizeWorkMin(input.workMin);
  const at = now.toISOString();
  return {
    subject,
    workMin,
    breakMin: clamp(toInt(input.breakMin) ?? POMODORO_BREAK_MIN, 1, 60),
    round: 1,
    phase: 'work',
    phaseStartedAt: at,
    phaseEndsAt: plusMin(at, workMin),
    startedAt: at,
    completed: 0,
  };
}

/** 这一轮之后是不是长休（每 4 轮一次） */
export function isLongBreakAfter(round: number): boolean {
  return round > 0 && round % POMODORO_SET_ROUNDS === 0;
}

/**
 * 翻到下一段：工作 → 休息（每 4 轮长休）；休息 → 下一轮工作。
 * ★ 只由用户在提醒 / 卡片上点，不由定时器调（口径 2）。工作段提前翻页也算完成一轮——他是主动说「够了，休息」。
 */
export function nextPomodoroPhase(s: PomodoroSession, now: Date): PomodoroSession {
  const at = now.toISOString();
  if (s.phase === 'work') {
    const breakMin = isLongBreakAfter(s.round) ? POMODORO_LONG_BREAK_MIN : s.breakMin;
    return { ...s, phase: 'break', phaseStartedAt: at, phaseEndsAt: plusMin(at, breakMin), completed: s.completed + 1 };
  }
  return { ...s, phase: 'work', round: s.round + 1, phaseStartedAt: at, phaseEndsAt: plusMin(at, s.workMin) };
}

/** 工作段「再来一轮」的快捷路径：跳过休息直接开下一轮 */
export function skipBreak(s: PomodoroSession, now: Date): PomodoroSession {
  return s.phase === 'work' ? nextPomodoroPhase(nextPomodoroPhase(s, now), now) : nextPomodoroPhase(s, now);
}

export function pomodoroRemainingMs(s: PomodoroSession, now: Date): number {
  return Math.max(0, Date.parse(s.phaseEndsAt) - now.getTime());
}

export function pomodoroPhaseDone(s: PomodoroSession, now: Date): boolean {
  return pomodoroRemainingMs(s, now) === 0;
}

/** 当前方向：只在工作段给（休息就是休息）；到点未翻页仍算在方向里（leftMin = 0） */
export function pomodoroFocus(s: PomodoroSession | null | undefined, now: Date): PomodoroFocus | null {
  if (!s || s.phase !== 'work') return null;
  return { subject: s.subject, leftMin: Math.ceil(pomodoroRemainingMs(s, now) / 60_000), round: s.round };
}

/** `MM:SS`（超过一小时 `H:MM:SS`） */
export function formatPomodoroClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ── 偏向：各功能共用的那几句话（只有这一份，别处不许自己拼）─────────────────

/** 进 system 段 / 出题 / 刷词提示词的那句话 */
export function pomodoroBiasLine(focus: PomodoroFocus): string {
  const left = focus.leftMin > 0 ? `还剩约 ${focus.leftMin} 分钟` : '刚到点';
  return `学习者正在进行番茄钟专注：这一段的学习方向是「${focus.subject}」（第 ${focus.round} 轮，${left}）。回答、举例、出题、推荐新词都优先围绕「${focus.subject}」；如果他的提问明显是别的话题，正常回答即可，不要硬扯回去，也不要反复提醒他在专注。`;
}

/** 出题主题：缺省主题换成方向；用户自己写了主题则在前面加一个方向标签 */
export function pomodoroTopic(topic: string | undefined, focus: PomodoroFocus | null): string | undefined {
  if (!focus) return topic;
  const t = (topic ?? '').trim();
  if (!t || t === '根据当前对话内容出题' || t === '综合') return `${focus.subject}（结合当前对话）`;
  return t.includes(focus.subject) ? t : `【${focus.subject}】${t}`;
}

/** 词条领域是否算「方向内」：大小写不敏感、互相包含即算（「数学」 vs 「高等数学」） */
export function domainMatchesFocus(domain: string, subject: string): boolean {
  const a = domain.trim().toLowerCase();
  const b = subject.trim().toLowerCase();
  return a !== '' && b !== '' && (a.includes(b) || b.includes(a));
}

// ── 提醒（督促胶囊右下角那枚气泡）────────────────────────────────────────────

export type PomodoroReminderKind = 'none' | 'work-done' | 'break-done' | 'setup';

export interface PomodoroReminder {
  kind: PomodoroReminderKind;
  line: string;
}

export interface PomodoroReminderInput {
  session: PomodoroSession | null;
  now: Date;
  /** 应用本次打开的时刻（没设钟的提醒要等人坐稳了再敲） */
  openedAt: Date;
  /** 上次「还没设钟」提醒的时刻（本机）；从未提醒过 null */
  lastSetupNudgeAt: Date | null;
}

/**
 * 该不该在胶囊旁冒泡（**唯一判断标准**）：
 *  1. 工作段到点 ⇒ `work-done`（最要紧：这是他定的闹钟）；
 *  2. 休息段到点 ⇒ `break-done`；
 *  3. 没开钟 ⇒ 打开满 3 分钟、且 2 小时内没敲过 ⇒ `setup`——提醒他「定个方向」，不是催他学；
 *  4. 其余 `none`。段内进行中**不冒泡**（倒计时在胶囊上，不需要第二处）。
 */
export function pomodoroReminder(i: PomodoroReminderInput): PomodoroReminder {
  const { session: s, now } = i;
  if (s) {
    if (!pomodoroPhaseDone(s, now)) return { kind: 'none', line: '' };
    if (s.phase === 'work') {
      const long = isLongBreakAfter(s.round);
      return {
        kind: 'work-done',
        line: `「${s.subject}」第 ${s.round} 轮 ${s.workMin} 分钟到了——${long ? `休息 ${POMODORO_LONG_BREAK_MIN} 分钟（长休）` : `休息 ${s.breakMin} 分钟`}？`,
      };
    }
    return { kind: 'break-done', line: `休息结束，继续「${s.subject}」第 ${s.round + 1} 轮？` };
  }
  if (now.getTime() - i.openedAt.getTime() < POMODORO_SETUP_NUDGE_DELAY_MS) return { kind: 'none', line: '' };
  if (i.lastSetupNudgeAt && now.getTime() - i.lastSetupNudgeAt.getTime() < POMODORO_SETUP_NUDGE_COOLDOWN_MS) {
    return { kind: 'none', line: '' };
  }
  return { kind: 'setup', line: '还没定番茄钟——先说接下来半小时学什么，对话、出题、刷词都会往那边靠。' };
}

/** 胶囊上的短标签：`🍅 数学 24:59` / `☕ 休息 04:10`；没开钟 null */
export function pomodoroCapsuleLabel(s: PomodoroSession | null, now: Date): string | null {
  if (!s) return null;
  const clock = formatPomodoroClock(pomodoroRemainingMs(s, now));
  return s.phase === 'work' ? `🍅 ${s.subject} ${clock}` : `☕ 休息 ${clock}`;
}

// ── 专注统计（督促小窗的学习可视化，契约 §10）────────────────────────────

export interface PomodoroDayStat {
  /** 本地日历日 `YYYY-MM-DD` */
  day: string;
  rounds: number;
  minutes: number;
}
export interface PomodoroSubjectStat {
  subject: string;
  rounds: number;
  minutes: number;
}
export interface PomodoroStats {
  today: { rounds: number; minutes: number };
  /** 近 N 天（含今天）逐日，按日期升序、缺日补 0——图上不出现「没发生过的专注」，也不跳过空白日 */
  recent: PomodoroDayStat[];
  /** 近 N 天按方向汇总，分钟降序 */
  bySubject: PomodoroSubjectStat[];
}

export const POMODORO_STATS_DAYS = 7;

/** 分钟 → 人话：`25 分` / `1 小时 05 分` / `2 小时` */
export function formatFocusMinutes(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} 小时` : `${h} 小时 ${String(r).padStart(2, '0')} 分`;
}

/** 面板表头那一行：`今日 2 轮 · 50 分`；今天还没专注过 ⇒ 看近 7 天；都没有 ⇒ 空串（由 UI 给引导语） */
export function pomodoroStatsLine(s: PomodoroStats): string {
  if (s.today.rounds > 0) return `今日 ${s.today.rounds} 轮 · ${formatFocusMinutes(s.today.minutes)}`;
  const rounds = s.recent.reduce((a, d) => a + d.rounds, 0);
  const minutes = s.recent.reduce((a, d) => a + d.minutes, 0);
  return rounds > 0 ? `近 ${s.recent.length} 天 ${rounds} 轮 · ${formatFocusMinutes(minutes)}` : '';
}
