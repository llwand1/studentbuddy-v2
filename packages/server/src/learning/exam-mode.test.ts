/**
 * exam-mode 回归锁：设置读写归主、上下文快照、站内直达 URL、出题提示词段。
 * 全程走隔离 DATA_DIR（`SB_DATA_DIR`），不碰真实库；零网络。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-exam-test-'));

const { getDb } = await import('../storage/db.js');
const {
  EXAM_CTX_OFF,
  buildExamPromptBlock,
  examAllowed,
  examDirectQueries,
  loadExamContext,
  loadExamMode,
  loadExamScope,
  saveExamMode,
  saveExamScope,
} = await import('./exam-mode.js');

beforeEach(() => {
  getDb().prepare('DELETE FROM app_settings').run();
});

describe('开关与范围按用户归主（v30 同族口径）', () => {
  it('缺省关；写了才是开', () => {
    expect(loadExamMode('u1')).toBe(false);
    expect(saveExamMode(true, 'u1')).toBe(true);
    expect(loadExamMode('u1')).toBe(true);
    // ★ u2 不受 u1 影响——写成全局单例的话，A 开应试模式会把 B 的搜索一起闸掉
    expect(loadExamMode('u2')).toBe(false);
  });

  it('匿名（null）落在空串行，与登录用户互不串', () => {
    saveExamMode(true, null);
    expect(loadExamMode(null)).toBe(true);
    expect(loadExamMode('u1')).toBe(false);
  });

  it('坏值不炸：JSON 解不出来时回缺省而不是抛穿', () => {
    getDb()
      .prepare('INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)')
      .run('u1', 'exam_mode', '不是 JSON');
    expect(loadExamMode('u1')).toBe(false);
    getDb()
      .prepare('INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)')
      .run('u1', 'exam_sources', '{{{');
    expect(loadExamScope('u1').packs.length).toBeGreaterThan(0);
  });
});

describe('loadExamContext', () => {
  it('关着 ⇒ EXAM_CTX_OFF（所有闸口旁路，行为与开启前一致）', () => {
    expect(loadExamContext('u1')).toEqual(EXAM_CTX_OFF);
  });

  it('开着 ⇒ 域名、话术、签名三样都齐', () => {
    saveExamMode(true, 'u1');
    saveExamScope({ packs: ['gaokao'], custom: [] }, 'u1');
    const ctx = loadExamContext('u1');
    expect(ctx.on).toBe(true);
    expect(ctx.hosts.length).toBeGreaterThan(0);
    expect(ctx.summary).toBe('高考');
    expect(ctx.signature).not.toBe('all');
    expect(ctx.sources.length).toBeGreaterThan(0);
  });

  it('开着但一个范围都没选 ⇒ hosts 空（调用方据此不发外部请求）', () => {
    saveExamMode(true, 'u1');
    saveExamScope({ packs: [], custom: [] }, 'u1');
    const ctx = loadExamContext('u1');
    expect(ctx.on).toBe(true);
    expect(ctx.hosts).toEqual([]);
  });
});

describe('examAllowed', () => {
  it('关着 ⇒ 一切放行（这是「零行为变化」的判据）', () => {
    expect(examAllowed('https://anything.example/x', EXAM_CTX_OFF)).toBe(true);
  });

  it('开着 ⇒ 范围内放行、范围外拦下、范围为空全拦', () => {
    saveExamMode(true, 'u1');
    saveExamScope({ packs: ['video'], custom: [] }, 'u1');
    const ctx = loadExamContext('u1');
    expect(examAllowed('https://search.bilibili.com/all?keyword=x', ctx)).toBe(true);
    expect(examAllowed('https://baike.baidu.com/item/x', ctx)).toBe(false);
    const empty = { ...ctx, hosts: [] as string[] };
    expect(examAllowed('https://search.bilibili.com/', empty)).toBe(false);
  });
});

describe('examDirectQueries', () => {
  it('开着的 question 档站点会拿到编码后的检索 URL', () => {
    saveExamMode(true, 'u1');
    saveExamScope({ packs: ['kaoyan'], custom: [] }, 'u1');
    const ctx = loadExamContext('u1');
    const hits = examDirectQueries('考研政治 马原', ctx);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.url).not.toContain('{q}');
      expect(encodeURIComponent('考研政治 马原')).toBeTruthy();
      expect(h.url.startsWith('https://')).toBe(true);
    }
  });

  it('关着 ⇒ 一条都不发（不打无谓的外部请求）', () => {
    expect(examDirectQueries('高考数学', EXAM_CTX_OFF)).toEqual([]);
  });

  it('空主题不发；超长主题截到 60 字（站点检索框普遍更短，超了返错误页）', () => {
    saveExamMode(true, 'u1');
    saveExamScope({ packs: ['kaoyan'], custom: [] }, 'u1');
    const ctx = loadExamContext('u1');
    expect(examDirectQueries('   ', ctx)).toEqual([]);
    const long = examDirectQueries('考'.repeat(200), ctx);
    for (const h of long) expect(decodeURIComponent(h.url.split('?')[1] ?? '').length).toBeLessThanOrEqual(80);
  });
});

describe('buildExamPromptBlock', () => {
  it('关着 ⇒ 空串：拼接后的出题提示词与开启前逐字一致', () => {
    expect(buildExamPromptBlock('u1')).toBe('');
  });

  it('开着 ⇒ 范围与「不得伪称真题」两句都在，且自带行尾换行', () => {
    saveExamMode(true, 'u1');
    saveExamScope({ packs: ['gongkao'], custom: [] }, 'u1');
    const block = buildExamPromptBlock('u1');
    expect(block).toContain('应试模式');
    expect(block).toContain('公务员');
    expect(block).toContain('不得声称出处与年份');
    expect(block.endsWith('\n')).toBe(true);
  });
});
