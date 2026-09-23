// @vitest-environment node
/**
 * auth/demo-seed — 体验号首屏种子的锁（渠道台账 C5）。
 *
 * ★ 本文件的核心不是「灌进去了没」，而是**灌进去的东西在真实读取路径下长成什么样**：
 *   队列读的是 `listDueQueue`、状态读的是 `computeReviewState`、领域读的是 `term_domain`——
 *   全是用它的人。若种子只是把列填上而读侧不认，首屏照样是空的，而那种空测不出来。
 * 第二条主线是**诚实**：种子不是用户产出，既不许动已有内容，也不许留下任何「有人用了」的痕迹
 * （事件总线零事件那条锁为此而写）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEMO_SEED_TERMS,
  DEMO_USER_ID,
  computeReviewState,
  demoSeedBackdateDays,
  reviewIntervalDays,
} from '@sb/shared';
import { closeDb, getDb, openIsolated } from '../storage/db.js';
import { listDueQueue } from '../learning/review-queue.js';
import { rowsAll } from '../learning/term-review.js';
import { saveOneTerm } from '../learning/terms.js';
import { subscribeEvents } from '../events/bus.js';
import { ensureDemoSeed } from './demo-seed.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-demo-seed-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const DEMO_TERMS_SQL = 'SELECT term, definition, domain, review_stage, last_reviewed_at, created_at' +
  ' FROM term_library WHERE owner_id = ?';

function seedRows(): Array<Record<string, string | number | null>> {
  return getDb().prepare(DEMO_TERMS_SQL).all(DEMO_USER_ID) as Array<Record<string, string | number | null>>;
}

describe('种子写入', () => {
  it('八条全落该池，且逐条带着释义与领域（不是先插壳再补）', () => {
    expect(ensureDemoSeed()).toBe(DEMO_SEED_TERMS.length);
    const rows = seedRows();
    expect(rows).toHaveLength(DEMO_SEED_TERMS.length);
    for (const t of DEMO_SEED_TERMS) {
      const row = rows.find((r) => r.term === t.term);
      expect(row, t.term).toBeDefined();
      expect(row?.definition).toBe(t.definition);
      expect(row?.domain).toBe(t.domain);
    }
  });

  it('★ v19 不变式成立：种子里出现的每个领域都进了 `term_domain`（领域 Tab 不漏项）', () => {
    ensureDemoSeed();
    const domains = getDb()
      .prepare('SELECT name FROM term_domain WHERE owner_id = ? ORDER BY name')
      .all(DEMO_USER_ID) as Array<{ name: string }>;
    expect(domains.map((d) => d.name).sort()).toEqual(
      [...new Set(DEMO_SEED_TERMS.map((t) => t.domain))].sort(),
    );
  });

  it('★ 复习流水按阶段数落，且阶段值停在约定档位（曲线与徽标读的就是这两样）', () => {
    ensureDemoSeed();
    const totalStages = DEMO_SEED_TERMS.reduce((s, t) => s + t.stage, 0);
    const logs = getDb()
      .prepare('SELECT COUNT(*) AS c FROM term_review_log l JOIN term_library t ON t.id = l.term_id WHERE t.owner_id = ?')
      .get(DEMO_USER_ID) as { c: number };
    expect(logs.c).toBe(totalStages);
    for (const t of DEMO_SEED_TERMS) {
      const row = seedRows().find((r) => r.term === t.term);
      expect(row?.review_stage, t.term).toBe(t.stage);
    }
  });

  it('★ 幂等：第二次直接返回 0，行数不变', () => {
    expect(ensureDemoSeed()).toBe(DEMO_SEED_TERMS.length);
    expect(ensureDemoSeed()).toBe(0);
    expect(seedRows()).toHaveLength(DEMO_SEED_TERMS.length);
  });

  it('★★ 池内只要已有任何词条（访客真存过的）就整批不灌、一个字都不改', () => {
    saveOneTerm('我自己存的词', '访客真实写入的一条，种子不许动它', '我的领域', DEMO_USER_ID);
    expect(ensureDemoSeed()).toBe(0);
    const rows = seedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.term).toBe('我自己存的词');
  });

  it('★ 种子用到的领域被**纳入复习范围**（不打开则队列恒空，见 `demo-seed.ts` 的 ④）', () => {
    ensureDemoSeed();
    const off = getDb()
      .prepare('SELECT COUNT(*) AS c FROM term_domain WHERE owner_id = ? AND review_enabled = 0')
      .get(DEMO_USER_ID) as { c: number };
    expect(off.c).toBe(0); // 三个种子领域全开
  });

  it('★★ 诚实红线：种子经领域函数写入 ⇒ 事件总线一条不发（C4 数不到它，XP／每日活动也不点亮）', () => {
    const seen: unknown[] = [];
    const off = subscribeEvents((e) => {
      seen.push(e);
    });
    ensureDemoSeed();
    off();
    expect(seen).toEqual([]);
    const act = getDb()
      .prepare('SELECT COUNT(*) AS c FROM daily_activity WHERE owner_id = ?')
      .get(DEMO_USER_ID) as { c: number };
    expect(act.c).toBe(0);
  });
});

describe('种子在真实读取路径下的样子', () => {
  it('★ 今日复习队列非空，且正是标了 `dueToday` 的那几条（首屏不是空态的直接判据）', () => {
    ensureDemoSeed();
    const due = listDueQueue(undefined, undefined, DEMO_USER_ID);
    expect(due.map((d) => d.term).sort()).toEqual(
      DEMO_SEED_TERMS.filter((t) => t.dueToday).map((t) => t.term).sort(),
    );
    expect(due.length).toBeGreaterThan(0);
  });

  it('★ 状态由契约算出、不由种子自说自话：到期＝`due`，未到期＝`upcoming`，从未复习＝按入库起算', () => {
    ensureDemoSeed();
    const rows = rowsAll(undefined, DEMO_USER_ID);
    expect(rows).toHaveLength(DEMO_SEED_TERMS.length); // ★ 先证明读得到，否则下面的循环空转、用例假过
    for (const row of rows) {
      const spec = DEMO_SEED_TERMS.find((t) => t.term === row.term)!;
      const state = computeReviewState({
        lastReviewedAt: row.last_reviewed_at,
        createdAt: row.created_at,
        stage: row.review_stage,
      });
      expect(state.stage, row.term).toBe(spec.stage);
      if (spec.stage === 0) {
        expect(state.basis, row.term).toBe('created');
        expect(state.status, row.term).toBe('upcoming');
      } else {
        expect(state.basis, row.term).toBe('review');
        expect(state.status, row.term).toBe(spec.dueToday ? 'due' : 'upcoming');
      }
    }
  });

  it('★ 时间算术不掺常数：到期那条恰好等满本阶段间隔，未到期那条今天才刚复习', () => {
    for (const t of DEMO_SEED_TERMS) {
      const back = demoSeedBackdateDays(t);
      expect(back).toBe(t.dueToday ? reviewIntervalDays(t.stage) : 0);
      if (t.stage > 0) expect(back).toBeLessThan(366); // 别把种子排到一年前——那是演示不是数据
    }
  });
});
