/**
 * chat/search-nudge — 联网检索触发词表的回归锁（bug-ledger B-006）。
 *
 * 纯函数测试，零 IO、零 DB：词表会随实测反复调，能单测才敢调（同 `choice-nudge.ts` 的理由）。
 *
 * 语料**优先取真机原话**——B-006 现场老板说的"你联网搜索试试""搜搜""搜索试试""那就搜索"
 * 都在下表里，它们是本次修复的**真实输入**，不是编出来的例句。
 * 尤其"搜搜"（2 字）：它是本文件与 `choice-nudge.ts`（MIN_LEN=4）最关键的差异点，
 * 长度门槛一旦被改回 4，这条用例会当场变红。
 */
import { describe, expect, it } from 'vitest';
import { SEARCH_NUDGE, searchNudge } from './search-nudge.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

describe('触发增强 searchNudge — 命中（真机原话优先）', () => {
  const HIT = [
    // ── B-006 现场原话（2026-09-17，老板要求联网检索时说的）──
    '你联网搜索试试',
    '搜搜',
    '搜索试试',
    '那就搜索',
    '那就多使用联网搜索的能力',
    '搜索一下agnesai,然后介绍一下',
    // ── 其他常见表述（词表要覆盖的同类诉求）──
    '帮我搜一下这个品牌',
    '帮我查一下这个人',
    '百度一下这个梗',
    '谷歌看看',
    '去网上查查',
    '最新的 AI 新闻给我讲讲',
    '今天的新闻有哪些',
  ];

  for (const t of HIT) {
    it(`命中：${t}`, () => {
      expect(searchNudge(t)).not.toBeNull();
    });
  }

  it('返回值就是 SEARCH_NUDGE（调用方据此注入，不得返回别的口径）', () => {
    expect(searchNudge('你联网搜索试试')).toBe(SEARCH_NUDGE);
  });

  it('硬指令里必须明确"具备联网能力"与"不要说没有联网能力"', () => {
    // 这两句是本次修复的**核心语义**（模型自我否定能力的纠偏），改动不得丢掉
    expect(SEARCH_NUDGE).toContain('具备联网搜索能力');
    expect(SEARCH_NUDGE).toContain('绝不要回答自己没有联网能力');
    // 时序要求：第一个动作就调，不许先弹选择框（B-006 现场正是弹了 ask_choice）
    expect(SEARCH_NUDGE).toContain('第一个动作');
    expect(SEARCH_NUDGE).toContain('ask_choice');
  });
});

describe('触发增强 searchNudge — 不命中（误搜守门人：学科术语）', () => {
  const MISS = [
    // 「搜索」在本仓学习场景里高频作算法术语——不拦就会把讲解题变成检索题
    '二分搜索的时间复杂度是多少',
    '搜索算法有哪些',
    '广度优先搜索和深度优先搜索的区别',
    '深度优先查找和广度优先查找',
    '二叉搜索树怎么删除节点',
    '搜索空间太大怎么办',
    '启发式搜索的原理',
    // 闲聊/追问类
    '在吗',
    '继续',
    '这个再讲讲',
  ];

  for (const t of MISS) {
    it(`不命中：${t}`, () => {
      expect(searchNudge(t)).toBeNull();
    });
  }
});

describe('触发增强 searchNudge — 边界', () => {
  it('空串 / 纯空白 / 单字 一律不判断', () => {
    expect(searchNudge('')).toBeNull();
    expect(searchNudge('   ')).toBeNull();
    expect(searchNudge('搜')).toBeNull();
  });

  it('★ 两字短指令必须命中（MIN_LEN=2 的钉子，改回 4 这条即红）', () => {
    // 与 choice-nudge 的 MIN_LEN=4 是**刻意不同**的：联网这条误搜代价低，
    // 而"搜搜""搜下""查查"本身就是完整诉求，被长度门槛吃掉就等于功能不存在。
    expect(searchNudge('搜搜')).not.toBeNull();
    expect(searchNudge('搜下')).not.toBeNull();
    expect(searchNudge('查查')).not.toBeNull();
  });

  it('未命中时返回 null（不是空串——调用方靠 null 判断是否注入）', () => {
    expect(searchNudge('在吗')).toBeNull();
  });
});

describe('防回退锁 — 提示词必须声明联网能力（B-006 的第一层触发）', () => {
  it('SYSTEM_PROMPT 点名 search_web 工具', () => {
    // 修复前：chart/html/update_tasks/ask_choice 都有引导，唯独 search_web 一字未提，
    // 这是模型「认为自己没有联网功能」的头号原因。此断言防它再次被删。
    expect(SYSTEM_PROMPT).toContain('search_web');
  });

  it('SYSTEM_PROMPT 明确禁止模型自称没有联网能力', () => {
    expect(SYSTEM_PROMPT).toContain('联网');
    expect(SYSTEM_PROMPT).toContain('我没有联网功能');
  });
});
