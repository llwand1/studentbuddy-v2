/**
 * storage/migrations-v46 —— 答题留痕两张表的结构锁（issue #56，2026-09-27）。
 *
 * ★ 与 `quiz-answer.test.ts` 的分工：那份跑的是真读写，**改坏行为**它会红；
 *   本文件钉的是"行为看不见、但形状决定它"的四条库面事实——它们出错的方式是**用例全绿而账是错的**：
 *  ① `answered_day` **不许有 DEFAULT**：给了 `date('now')` 兜底，写手哪天忘填本地日键
 *     就会静默落 UTC 日，而这张表唯一的用途就是按日聚合（+8 区晚上错一天）。
 *     "忘填"在功能用例里根本测不出来——它照样有一行，只是日子是别人的。
 *  ② `quiz_answer_log` **没有 owner 列**：归属单点在 `sessions`，两处都存迟早分叉
 *     （`term_review_log` 为同一件事写过注释，见 v22/v45 两片文件头）。
 *     加一列 `owner_id` 看起来只是"方便查"，实际是把隔离变成两本账。
 *  ③ `ux_quiz_answer_once` 必须是**唯一**索引：不是"有个叫这名字的索引"，
 *     是它真的能拦第二次——`quiz_answered` 挂着 XP=3，这条不唯一就是刷新刷分。
 *  ④ 本版**零 ALTER 零 DROP**：这是「重放天然幂等」与 `-v44.ts` 那条
 *     「往后每 DROP 一张表，所有退版本重放用例都要手工补回那张表」的常驻约束**没有被本批触发**的证据。
 *
 * ★ 为什么不追加进 `db.test.ts`：那里 1300+ 行的「退版本重放」用例是共享面，
 *   同批改容易与同伴在途的分支撞车（v44/v45 两片各自开测试文件的理由同一条）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-v46-test-'));
const { openIsolated, closeDb } = await import('./db.js');
const { MIGRATIONS } = await import('./migrations-list.js');

const v46 = MIGRATIONS.find((m) => m.version === 46);
if (!v46) throw new Error('迁移清单里没有 v46');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-v46-test-'));
}

type ColInfo = { name: string; dflt_value: string | null };
type IdxInfo = { name: string; unique: number };

const colsOf = (db: ReturnType<typeof openIsolated>, table: string): ColInfo[] =>
  db.prepare(`PRAGMA table_info(${table})`).all() as ColInfo[];
const idxOf = (db: ReturnType<typeof openIsolated>, table: string): IdxInfo[] =>
  db.prepare(`PRAGMA index_list(${table})`).all() as unknown as IdxInfo[];

describe('v46 建的两张表', () => {
  it('库面：`quiz_block` 与 `quiz_answer_log` 都在，且形状就是契约那几列', () => {
    const db = openIsolated(tmp());
    expect(colsOf(db, 'quiz_block').map((c) => c.name)).toEqual(['quiz_id', 'session_id', 'questions', 'created_at']);
    expect(colsOf(db, 'quiz_answer_log').map((c) => c.name)).toEqual([
      'id',
      'quiz_id',
      'question_index',
      'qtype',
      'correct',
      'answered_day',
      'answered_at',
    ]);
    closeDb();
  });

  it('① `answered_day` 没有 DEFAULT —— 兜底一旦存在，忘填本地日键就会静默落成 UTC 日', () => {
    const db = openIsolated(tmp());
    const day = colsOf(db, 'quiz_answer_log').find((c) => c.name === 'answered_day');
    expect(day?.dflt_value).toBe(null);
    // 而 `answered_at` 有兜底是**有意的**：那是"何时写的"这种审计字段，UTC 无妨；
    // `answered_day` 是聚合键，两者不是一回事（照 `term_review_log` 的两列同表不同待遇）。
    expect(colsOf(db, 'quiz_answer_log').find((c) => c.name === 'answered_at')?.dflt_value).toContain('datetime');
    closeDb();
  });

  it('② 流水表与钥匙表都**不带 owner 列**：归属只经会话带出来', () => {
    const db = openIsolated(tmp());
    for (const t of ['quiz_block', 'quiz_answer_log']) {
      expect(colsOf(db, t).map((c) => c.name)).not.toContain('owner_id');
      expect(colsOf(db, t).map((c) => c.name)).not.toContain('user_id');
    }
    closeDb();
  });

  it('③ `(quiz_id, question_index)` 是**唯一**索引（不是同名普通索引）——重答不拦就是刷新刷 XP', () => {
    const db = openIsolated(tmp());
    const idx = idxOf(db, 'quiz_answer_log').find((i) => i.name === 'ux_quiz_answer_once');
    expect(idx?.unique).toBe(1);
    // 只钉"它是唯一的"不够：真插两次才算拦得住
    const ins = db.prepare(
      `INSERT INTO quiz_answer_log (id, quiz_id, question_index, qtype, correct, answered_day)
       VALUES (?, 'v46-q', 0, 'single', 1, '2026-09-27')`,
    );
    ins.run('v46-a');
    expect(() => ins.run('v46-b')).toThrow(/UNIQUE/i);
    closeDb();
  });
});

describe('v46 对迁移链的承诺', () => {
  it('④ 零 ALTER、零 DROP ⇒ 重放天然幂等，`revertV33()` 那批用例不受本批影响', () => {
    const joined = v46.statements.join('\n').toUpperCase();
    expect(joined).not.toContain('ALTER TABLE');
    expect(joined).not.toContain('DROP TABLE');
    expect(joined).not.toContain('DROP INDEX');
    expect(joined).not.toContain('VACUUM'); // 执行器每版一事务，VACUUM 进不去（`-v44.ts` 文件头那条）
  });

  it('v46 那四条语句**二次执行不炸**（`IF NOT EXISTS` 不是习惯性多写）', () => {
    /**
     * ⚠️ 这里刻意**不**用「抹掉 `schema_version` 让执行器重跑整条链」那个写法：
     * 链上 v2x 那批是 `ALTER TABLE ADD COLUMN`，二次执行必然 `duplicate column name`
     * ——那是**既有**性质（`-v44.ts` 文件头与 `db.test.ts::revertV33()` 记的就是这件事），
     * 与 v46 无关。要钉的只有"本批这几条能不能重放"，所以直接对同一个库 `exec` 两遍。
     */
    const db = openIsolated(tmp());
    expect(() => {
      for (const stmt of v46.statements) db.exec(stmt);
      for (const stmt of v46.statements) db.exec(stmt);
    }).not.toThrow();
    expect(colsOf(db, 'quiz_answer_log')).toHaveLength(7);
    closeDb();
  });

  it('建库后的头号版本 = 清单最高版本（这条每加一版都会自动跟着走，不写死数字）', () => {
    const db = openIsolated(tmp());
    const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(v.v).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
    expect(v.v).toBeGreaterThanOrEqual(46);
    closeDb();
  });
});
