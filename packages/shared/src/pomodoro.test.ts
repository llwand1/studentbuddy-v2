/**
 * shared/pomodoro 纯函数：开钟 / 翻段 / 方向 / 提醒判定 / 偏向文案（契约 `docs/POMODORO-SPEC.md`）。
 * 全部注入 `now`，不读真实时钟。
 */
import { describe, expect, it } from 'vitest';
import {
  POMODORO_LONG_BREAK_MIN,
  POMODORO_SETUP_NUDGE_COOLDOWN_MS,
  POMODORO_SETUP_NUDGE_DELAY_MS,
  POMODORO_SUBJECT_MAX,
  POMODORO_WORK_MAX,
  POMODORO_WORK_MIN,
  domainMatchesFocus,
  formatPomodoroClock,
  isLongBreakAfter,
  nextPomodoroPhase,
  normalizePomodoro,
  normalizePomodoroSubject,
  pomodoroBiasLine,
  pomodoroCapsuleLabel,
  pomodoroFocus,
  pomodoroRemainingMs,
  pomodoroReminder,
  pomodoroTopic,
  skipBreak,
  startPomodoro,
} from './pomodoro.js';
import { focusGuideText, ruleGuide, type GuideFacts } from './guide.js';
import { orderDrillQueue, type DrillQueueTerm } from './drill.js';

const T0 = new Date('2026-10-01T08:00:00.000Z');
const at = (min: number): Date => new Date(T0.getTime() + min * 60_000);

describe('开钟与归一', () => {
  it('startPomodoro：第 1 轮工作段、结束时刻 = 开始 + workMin；方向为空 ⇒ null', () => {
    const s = startPomodoro({ subject: ' 数学 ', workMin: 30 }, T0);
    expect(s).not.toBeNull();
    expect(s?.subject).toBe('数学');
    expect(s?.phase).toBe('work');
    expect(s?.round).toBe(1);
    expect(s?.completed).toBe(0);
    expect(s?.phaseEndsAt).toBe(at(30).toISOString());
    expect(startPomodoro({ subject: '   ' }, T0)).toBeNull();
  });

  it('时长钳位到 [5, 180]，缺省 25；方向截到上限并剔控制字符', () => {
    expect(startPomodoro({ subject: 'x', workMin: 1 }, T0)?.workMin).toBe(POMODORO_WORK_MIN);
    expect(startPomodoro({ subject: 'x', workMin: 9999 }, T0)?.workMin).toBe(POMODORO_WORK_MAX);
    expect(startPomodoro({ subject: 'x' }, T0)?.workMin).toBe(25);
    expect(normalizePomodoroSubject('数\u0000学\n极限')).toBe('数 学 极限');
    expect(Array.from(normalizePomodoroSubject('字'.repeat(99)) ?? '').length).toBe(POMODORO_SUBJECT_MAX);
  });

  it('normalizePomodoro：round-trip 原样；坏时间 / 非对象 / 空方向 ⇒ null', () => {
    const s = startPomodoro({ subject: '物理', workMin: 45 }, T0);
    expect(normalizePomodoro(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(normalizePomodoro({ ...s, phaseEndsAt: 'nope' })).toBeNull();
    expect(normalizePomodoro({ ...s, subject: '' })).toBeNull();
    expect(normalizePomodoro('x')).toBeNull();
    expect(normalizePomodoro(null)).toBeNull();
  });
});

describe('翻段', () => {
  const s = startPomodoro({ subject: '数学', workMin: 25, breakMin: 5 }, T0)!;

  it('工作 → 休息：completed +1、休息 5 分钟；休息 → 工作：round +1', () => {
    const b = nextPomodoroPhase(s, at(25));
    expect(b.phase).toBe('break');
    expect(b.completed).toBe(1);
    expect(b.round).toBe(1);
    expect(b.phaseEndsAt).toBe(at(30).toISOString());
    const w = nextPomodoroPhase(b, at(30));
    expect(w.phase).toBe('work');
    expect(w.round).toBe(2);
    expect(w.phaseEndsAt).toBe(at(55).toISOString());
  });

  it('每 4 轮一次长休 15 分钟', () => {
    expect(isLongBreakAfter(4)).toBe(true);
    expect(isLongBreakAfter(3)).toBe(false);
    const r4 = { ...s, round: 4 };
    const b = nextPomodoroPhase(r4, T0);
    expect(pomodoroRemainingMs(b, T0)).toBe(POMODORO_LONG_BREAK_MIN * 60_000);
  });

  it('skipBreak：工作段直接开下一轮（这一轮仍算完成）；休息段就是结束休息', () => {
    const w2 = skipBreak(s, at(10));
    expect(w2.phase).toBe('work');
    expect(w2.round).toBe(2);
    expect(w2.completed).toBe(1);
    const b = nextPomodoroPhase(s, at(25));
    expect(skipBreak(b, at(26)).round).toBe(2);
  });

  it('到点不自动翻页：remaining 0、phase 仍 work；focus 仍在、leftMin 0', () => {
    expect(pomodoroRemainingMs(s, at(40))).toBe(0);
    expect(pomodoroFocus(s, at(40))).toEqual({ subject: '数学', leftMin: 0, round: 1 });
  });
});

describe('方向与偏向文案', () => {
  const s = startPomodoro({ subject: '数学', workMin: 30 }, T0)!;

  it('只在工作段有方向；休息段 null；leftMin 向上取整', () => {
    expect(pomodoroFocus(s, at(10.2))?.leftMin).toBe(20);
    expect(pomodoroFocus(nextPomodoroPhase(s, at(30)), at(31))).toBeNull();
    expect(pomodoroFocus(null, T0)).toBeNull();
  });

  it('偏向句引用方向与轮次，并明说「别的话题正常回答」', () => {
    const line = pomodoroBiasLine({ subject: '数学', leftMin: 12, round: 2 });
    expect(line).toContain('「数学」');
    expect(line).toContain('第 2 轮');
    expect(line).toContain('12 分钟');
    expect(line).toContain('不要硬扯回去');
    expect(pomodoroBiasLine({ subject: '数学', leftMin: 0, round: 1 })).toContain('刚到点');
  });

  it('出题主题：缺省主题换成方向；自定主题加方向标签；已含方向不重复；没方向原样', () => {
    const f = { subject: '数学', leftMin: 5, round: 1 };
    expect(pomodoroTopic('根据当前对话内容出题', f)).toBe('数学（结合当前对话）');
    expect(pomodoroTopic(undefined, f)).toBe('数学（结合当前对话）');
    expect(pomodoroTopic('二次函数', f)).toBe('【数学】二次函数');
    expect(pomodoroTopic('数学归纳法', f)).toBe('数学归纳法');
    expect(pomodoroTopic('二次函数', null)).toBe('二次函数');
  });

  it('领域匹配：互相包含、大小写不敏感、空串不匹配', () => {
    expect(domainMatchesFocus('高等数学', '数学')).toBe(true);
    expect(domainMatchesFocus('数学', '高等数学')).toBe(true);
    expect(domainMatchesFocus('JS', 'js')).toBe(true);
    expect(domainMatchesFocus('物理', '数学')).toBe(false);
    expect(domainMatchesFocus('', '数学')).toBe(false);
  });

  it('时钟格式 MM:SS，超一小时 H:MM:SS，负数当 0', () => {
    expect(formatPomodoroClock(25 * 60_000)).toBe('25:00');
    expect(formatPomodoroClock(61_000)).toBe('01:01');
    expect(formatPomodoroClock(3_600_000 + 5_000)).toBe('1:00:05');
    expect(formatPomodoroClock(-5)).toBe('00:00');
    expect(pomodoroCapsuleLabel(s, at(5))).toBe('🍅 数学 25:00');
    expect(pomodoroCapsuleLabel(nextPomodoroPhase(s, at(30)), at(31))).toBe('☕ 休息 04:00');
    expect(pomodoroCapsuleLabel(null, T0)).toBeNull();
  });
});

describe('提醒判定（胶囊旁气泡）', () => {
  const s = startPomodoro({ subject: '数学', workMin: 25, breakMin: 5 }, T0)!;
  const base = { openedAt: T0, lastSetupNudgeAt: null };

  it('工作段进行中不冒泡；到点 ⇒ work-done 并带轮次与休息时长；第 4 轮说长休', () => {
    expect(pomodoroReminder({ ...base, session: s, now: at(10) }).kind).toBe('none');
    const r = pomodoroReminder({ ...base, session: s, now: at(25) });
    expect(r.kind).toBe('work-done');
    expect(r.line).toContain('「数学」第 1 轮 25 分钟');
    expect(r.line).toContain('休息 5 分钟');
    expect(pomodoroReminder({ ...base, session: { ...s, round: 4 }, now: at(25) }).line).toContain('长休');
  });

  it('休息到点 ⇒ break-done，说的是下一轮', () => {
    const b = nextPomodoroPhase(s, at(25));
    expect(pomodoroReminder({ ...base, session: b, now: at(27) }).kind).toBe('none');
    const r = pomodoroReminder({ ...base, session: b, now: at(30) });
    expect(r.kind).toBe('break-done');
    expect(r.line).toContain('第 2 轮');
  });

  it('没开钟：打开未满 3 分钟不敲；满了敲 setup；2 小时冷却内不再敲；冷却过了再敲', () => {
    expect(pomodoroReminder({ ...base, session: null, now: new Date(T0.getTime() + POMODORO_SETUP_NUDGE_DELAY_MS - 1) }).kind).toBe('none');
    const r = pomodoroReminder({ ...base, session: null, now: new Date(T0.getTime() + POMODORO_SETUP_NUDGE_DELAY_MS) });
    expect(r.kind).toBe('setup');
    expect(r.line).toContain('番茄钟');
    const nudged = at(5);
    expect(
      pomodoroReminder({ openedAt: T0, lastSetupNudgeAt: nudged, session: null, now: new Date(nudged.getTime() + POMODORO_SETUP_NUDGE_COOLDOWN_MS - 1) })
        .kind,
    ).toBe('none');
    expect(
      pomodoroReminder({ openedAt: T0, lastSetupNudgeAt: nudged, session: null, now: new Date(nudged.getTime() + POMODORO_SETUP_NUDGE_COOLDOWN_MS) }).kind,
    ).toBe('setup');
  });
});

describe('偏向落到引路灯与刷词（shared 内的两处消费方）', () => {
  const facts = (focus: GuideFacts['focus']): GuideFacts => ({
    lang: 'zh',
    view: 'chat',
    can: ['chat.topic', 'quiz.start', 'nav.terms', 'nav.continent'],
    busy: false,
    hasModel: true,
    chat: null,
    terms: { total: 0, due: 0, overdue: 0, streak: 0 },
    sessions: 0,
    focus,
  });

  it('引路灯：有方向 ⇒ 话题 / 追问文本与出题副行都写方向；没方向 ⇒ 退随机话题', () => {
    const f = { subject: '数学', leftMin: 10, round: 1 };
    expect(focusGuideText('chat.topic', { lang: 'zh', focus: f }, 0)).toContain('「数学」');
    expect(focusGuideText('chat.topic', { lang: 'en', focus: f }, 1)).toContain('"数学"');
    expect(focusGuideText('chat.ask', { lang: 'zh', focus: f })).toContain('「数学」');
    expect(focusGuideText('chat.topic', { lang: 'zh', focus: null }, 0)).not.toContain('数学');
    expect(focusGuideText('nav.terms', { lang: 'zh', focus: f })).toBeUndefined();
    const r = ruleGuide(facts(f), 2);
    expect(r.items[0]?.kind).toBe('chat.topic');
    expect(r.items[0]?.text).toContain('数学');
    const chatted = ruleGuide({ ...facts(f), chat: { rounds: 2, lastUser: '问了点别的', lastAssistant: '', quizzes: 0 } }, 0);
    expect(chatted.items.find((i) => i.kind === 'quiz.start')?.hint).toContain('「数学」');
  });

  it('刷词队列：方向内的词条在到期段 / 非到期段各自排前；不改到期优先；没方向顺序照旧', () => {
    const t = (id: string, domain: string, due: boolean): DrillQueueTerm => ({
      id,
      term: id,
      definition: `${id} 的释义`,
      domain,
      status: due ? 'due' : 'upcoming',
      inScope: true,
    });
    const terms = [t('a', '物理', false), t('b', '数学', false), t('c', '物理', true), t('d', '高等数学', true)];
    const plain = orderDrillQueue(terms, '2026-10-01');
    expect(plain.slice(0, 2).map((q) => q.origin)).toEqual(['due', 'due']);
    const focused = orderDrillQueue(terms, '2026-10-01', new Set(), '数学');
    expect(focused.map((q) => q.term.id)).toEqual(['d', 'c', 'b', 'a']);
    expect(focused.map((q) => q.origin)).toEqual(['due', 'due', 'library', 'library']);
  });
});
