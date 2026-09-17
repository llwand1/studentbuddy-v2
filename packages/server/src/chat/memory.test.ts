/**
 * chat/memory 单测（openIsolated 隔离库，同 notes.test.ts 手法）。
 * 钉契约核心语义（docs/MEMORY-SPEC.md §5）：upsert 幂等 + importance 取 MAX、
 * 淘汰按 importance 升序、注入段按 kind 分组且硬限长、低于门槛不注入、非法 kind 丢弃。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MEMORY_INJECT_MAX_CHARS, MEMORY_MAX_ITEMS, MEMORY_MIN_IMPORTANCE } from '@sb/shared';
import type { MemoryDraft, MemoryItem } from '@sb/shared';
import { closeDb, getDb, openIsolated } from '../storage/db.js';
import {
  buildMemoryBlock,
  clearMemory,
  injectMemoryBlock,
  loadMemoryItems,
  markMemoryUsed,
  pruneMemoryItems,
  removeMemory,
  upsertMemoryItems,
} from './memory.js';

const dataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-memory-test-'));

beforeEach(() => openIsolated(dataDir()));
afterEach(() => closeDb());

const draft = (kind: MemoryDraft['kind'], content: string, importance = 0.5): MemoryDraft => ({
  kind,
  content,
  importance,
});

const mkItem = (id: string, kind: MemoryItem['kind'], content: string, importance: number): MemoryItem => ({
  id,
  kind,
  content,
  importance,
  sourceSessionId: null,
  createdAt: '2026-09-15 00:00:00',
  updatedAt: '2026-09-15 00:00:00',
});

describe('upsertMemoryItems（幂等入库）', () => {
  it('同 kind + 同 content 不新增行，importance 取 MAX（低分不覆盖高分）', () => {
    upsertMemoryItems([draft('preference', '喜欢先看例子再看定义', 0.3)]);
    upsertMemoryItems([draft('preference', '喜欢先看例子再看定义', 0.8)]);
    expect(loadMemoryItems()).toHaveLength(1);
    expect(loadMemoryItems()[0]?.importance).toBe(0.8);

    upsertMemoryItems([draft('preference', '喜欢先看例子再看定义', 0.2)]);
    expect(loadMemoryItems()).toHaveLength(1);
    expect(loadMemoryItems()[0]?.importance).toBe(0.8);
  });

  it('同 content 但不同 kind 视为两条（类别是身份的一部分）', () => {
    upsertMemoryItems([draft('weakness', '指针混淆'), draft('goal', '指针混淆')]);
    expect(loadMemoryItems()).toHaveLength(2);
  });

  it('非法 kind 一律丢弃，**不回落成某一类**（猜错的类别比没类别更糟）', () => {
    const n = upsertMemoryItems([
      { kind: 'nonsense' as MemoryDraft['kind'], content: '该被丢弃', importance: 0.9 },
      draft('profile', '正常条目'),
    ]);
    expect(n).toBe(1);
    const items = loadMemoryItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.content).toBe('正常条目');
  });

  it('空内容 / 纯空白丢弃', () => {
    expect(upsertMemoryItems([draft('profile', '   '), draft('goal', '')])).toBe(0);
    expect(loadMemoryItems()).toHaveLength(0);
  });

  it('importance 非数字回落 0.5、越界 clamp 到 [0,1]（逐字段归一，不作废整条）', () => {
    upsertMemoryItems([
      { kind: 'profile', content: '非数字', importance: Number.NaN },
      { kind: 'goal', content: '越上界', importance: 99 },
      { kind: 'weakness', content: '越下界', importance: -5 },
    ]);
    const map = new Map(loadMemoryItems().map((m) => [m.content, m.importance]));
    expect(map.get('非数字')).toBe(0.5);
    expect(map.get('越上界')).toBe(1);
    expect(map.get('越下界')).toBe(0);
  });
});

describe('pruneMemoryItems（容量控制）', () => {
  it(`超 ${MEMORY_MAX_ITEMS} 条时按 importance 升序淘汰最低分`, () => {
    const drafts: MemoryDraft[] = [];
    for (let i = 0; i < MEMORY_MAX_ITEMS + 3; i++) drafts.push(draft('profile', `事实${i}`, i / 100));
    upsertMemoryItems(drafts);

    expect(pruneMemoryItems()).toBe(3);
    const left = loadMemoryItems();
    expect(left).toHaveLength(MEMORY_MAX_ITEMS);
    expect(left.some((m) => m.content === '事实0')).toBe(false);
    expect(left.some((m) => m.content === '事实2')).toBe(false);
    expect(left.some((m) => m.content === '事实3')).toBe(true);
  });

  it('未超上限时不动库', () => {
    upsertMemoryItems([draft('profile', '唯一一条')]);
    expect(pruneMemoryItems()).toBe(0);
    expect(loadMemoryItems()).toHaveLength(1);
  });
});

describe('buildMemoryBlock（纯函数：排序 / 分组 / 截断）', () => {
  it('按 kind 固定顺序分组，组内按 importance 倒序', () => {
    const { block, usedIds } = buildMemoryBlock([
      mkItem('a', 'goal', 'G', 0.9),
      mkItem('b', 'preference', 'P1', 0.5),
      mkItem('c', 'preference', 'P2', 0.8),
    ]);
    // MEMORY_KINDS 声明序：profile → preference → weakness → goal
    expect(block.indexOf('【学习偏好】')).toBeLessThan(block.indexOf('【学习目标】'));
    expect(block).toContain('P2；P1');
    expect(usedIds).toHaveLength(3);
  });

  it('低于 MEMORY_MIN_IMPORTANCE 的不注入（仍留在库里）', () => {
    const { block, usedIds } = buildMemoryBlock([
      mkItem('low', 'weakness', '低分事实', MEMORY_MIN_IMPORTANCE - 0.01),
    ]);
    expect(block).toBe('');
    expect(usedIds).toHaveLength(0);
  });

  it('全空 / 全部低于门槛 → 空串（调用方据此不注入该段）', () => {
    expect(buildMemoryBlock([]).block).toBe('');
  });

  it('注入段总长**恒不超** MEMORY_INJECT_MAX_CHARS（恒注入故必须硬限长）', () => {
    const items = Array.from({ length: MEMORY_MAX_ITEMS }, (_, i) =>
      mkItem(`i${i}`, 'profile', '一条相当长的记忆内容'.repeat(4), 0.9),
    );
    const { block, usedIds } = buildMemoryBlock(items);
    expect(block.length).toBeLessThanOrEqual(MEMORY_INJECT_MAX_CHARS);
    // 装不下就要真的截断，而不是全塞进去
    expect(usedIds.length).toBeLessThan(items.length);
    expect(usedIds.length).toBeGreaterThan(0);
  });
});

describe('markMemoryUsed / injectMemoryBlock（记账）', () => {
  it('markMemoryUsed 累加 usage_count，**不改 importance**（它不是淘汰依据）', () => {
    upsertMemoryItems([draft('profile', '一条事实', 0.7)]);
    const id = loadMemoryItems()[0]?.id ?? '';
    markMemoryUsed([id]);
    markMemoryUsed([id]);
    const row = getDb().prepare('SELECT usage_count, importance FROM user_memory WHERE id = ?').get(id) as {
      usage_count: number;
      importance: number;
    };
    expect(row.usage_count).toBe(2);
    expect(row.importance).toBe(0.7);
  });

  it('injectMemoryBlock 一步到位：建段 + 记账（少记账＝观察窗失效）', () => {
    upsertMemoryItems([draft('preference', '喜欢列点作答', 0.8)]);
    const block = injectMemoryBlock();
    expect(block).toContain('喜欢列点作答');
    const row = getDb().prepare('SELECT usage_count FROM user_memory').get() as { usage_count: number };
    expect(row.usage_count).toBe(1);
  });

  it('无画像时返空串且不抛（开箱路径）', () => {
    expect(injectMemoryBlock()).toBe('');
  });
});

describe('removeMemory / clearMemory（逃生口）', () => {
  it('removeMemory 返回是否真删掉（供路由区分 200 与 404）', () => {
    upsertMemoryItems([draft('profile', 'A'), draft('goal', 'B')]);
    const id = loadMemoryItems()[0]?.id ?? '';
    expect(removeMemory(id)).toBe(true);
    expect(removeMemory('not-exist-id')).toBe(false);
    expect(loadMemoryItems()).toHaveLength(1);
  });

  it('clearMemory 清空并返回条数', () => {
    upsertMemoryItems([draft('profile', 'A'), draft('goal', 'B'), draft('weakness', 'C')]);
    expect(clearMemory()).toBe(3);
    expect(loadMemoryItems()).toHaveLength(0);
  });
});
