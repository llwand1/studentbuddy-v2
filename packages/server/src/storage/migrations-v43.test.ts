/**
 * storage/migrations-v43 — `pk_invites` 表的结构锁（契约 `docs/PK-SPEC.md` §16）。
 *
 * ★ 为什么单开文件、不追加进 `db.test.ts`：那条链此刻正被同仓另一个会话占用（v42 未提交），
 *   往里加用例＝踩进别人的工作面。本批与 v41/v42 那批唯一的交叉是「聚合出口少一个 import」，
 *   等两批都落了再由后人并回 `db.test.ts`（纯搬运）。
 *
 * 本文件只钉**迁移该负责的东西**＝表形状与默认值；邀请的行为断言（幂等接受、频率闸门、
 * 跨归属读不到别人的邀请）归 `pk/invite.test.ts`，与 v39 那条「行为在别处、这里只钉结构」同分工。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated } from './db.js';
import { MIGRATIONS } from './migrations-list.js';

/** 最高版本号用算的、不写死（`db.test.ts` 里那段理由的同一取向：写死＝多抄一份会漂移的快照） */
const HEAD_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-v43-test-'));
}

const tablesOf = (db: ReturnType<typeof openIsolated>): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((r) => r.name);

const indexesOf = (db: ReturnType<typeof openIsolated>, table: string): string[] =>
  (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?`).all(table) as Array<{
      name: string;
    }>
  ).map((r) => r.name);

/** 插一行最小形态（`status`/`reason` 都靠默认值，正好被用例 2 钉住） */
function insertBare(db: ReturnType<typeof openIsolated>, id = 'pki-1'): void {
  db.prepare(`INSERT INTO pk_invites (id, session_id, topic) VALUES (?, ?, ?)`).run(id, 's-1', '正弦定理');
}

describe('storage/db — v43 对战邀请表（pk_invites）', () => {
  it('新库有 pk_invites 与两条闸门索引', () => {
    const db = openIsolated(tmp());
    expect(tablesOf(db)).toContain('pk_invites');
    expect(indexesOf(db, 'pk_invites')).toEqual(
      expect.arrayContaining(['idx_pk_invites_session', 'idx_pk_invites_owner']),
    );
    db.close();
  });

  it('★ 状态默认 pending、理由默认空串，且**不拦未知状态**（无 CHECK＝域层归一，同 v25 `kind` 取向）', () => {
    const db = openIsolated(tmp());
    insertBare(db);
    const row = db.prepare(`SELECT status, reason, room_id, owner_id FROM pk_invites WHERE id = 'pki-1'`).get() as {
      status: string;
      reason: string;
      room_id: string | null;
      owner_id: string | null;
    };
    expect(row).toEqual({ status: 'pending', reason: '', room_id: null, owner_id: null });
    expect(() => db.prepare(`UPDATE pk_invites SET status = 'whatever' WHERE id = 'pki-1'`).run()).not.toThrow();
    db.close();
  });

  it('★ session_id / topic 是 NOT NULL；owner_id 可空（本地单人形态无主，与 `ownerIdOf → null` 同语义）', () => {
    const db = openIsolated(tmp());
    expect(() => db.prepare(`INSERT INTO pk_invites (id, topic) VALUES ('x', 't')`).run()).toThrow();
    expect(() => db.prepare(`INSERT INTO pk_invites (id, session_id) VALUES ('x', 's')`).run()).toThrow();
    expect(() =>
      db.prepare(`INSERT INTO pk_invites (id, session_id, owner_id, topic) VALUES ('x', 's', NULL, 't')`).run(),
    ).not.toThrow();
    db.close();
  });

  it('★ created_at 与 `datetime(\'now\',...)` 同口径可比（频率闸门全靠这一条，UTC 文本坑的先例见 v39 注）', () => {
    const db = openIsolated(tmp());
    insertBare(db);
    // 「近 5 分钟发过几张」——刚插的行必须数得到；若默认值哪天被改成 unix 毫秒整数，这条立刻红
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM pk_invites WHERE session_id = 's-1' AND created_at > datetime('now','-5 minutes')`).get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM pk_invites WHERE created_at > datetime('now','+1 day')`).get() as { n: number })
        .n,
    ).toBe(0);
    db.close();
  });

  it('同目录二次打开：不重复建表、已有行原样在（迁移幂等）', () => {
    const dir = tmp();
    const first = openIsolated(dir);
    insertBare(first);
    first.close();

    const second = openIsolated(dir);
    expect(
      (second.prepare(`SELECT COUNT(*) AS n FROM pk_invites WHERE id = 'pki-1'`).get() as { n: number }).n,
    ).toBe(1);
    second.close();
  });

  it('★ 退到 v42 重放：先 DROP 干净，表与索引由 v43 建回来，且库落在清单头号', () => {
    const dir = tmp();
    const old = openIsolated(dir);
    old.exec(`DROP INDEX IF EXISTS idx_pk_invites_session`);
    old.exec(`DROP INDEX IF EXISTS idx_pk_invites_owner`);
    old.exec(`DROP TABLE IF EXISTS pk_invites`);
    old.prepare(`DELETE FROM schema_version WHERE version > 42`).run();
    expect(tablesOf(old)).not.toContain('pk_invites'); // 退干净了，下面的「建回」才不是空话
    old.close();

    const up = openIsolated(dir);
    expect(tablesOf(up)).toContain('pk_invites');
    expect(indexesOf(up, 'pk_invites')).toContain('idx_pk_invites_session');
    expect((up.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number }).v).toBe(HEAD_VERSION);
    up.close();
  });
});

/**
 * 清单形状锁（本批实测顺带立的一条，**不是**「版本号必须连续」）。
 *
 * ★ 为什么钉这个：执行器 `migrations.ts` 的判据是 `if (m.version <= current) continue`，
 *   而 `current` 取的是 `MAX(version)`——**它按数组顺序跑、按最大值跳过**。
 *   于是两条独立的错都会表现成「某张表莫名不存在、且零报错」：
 *   ① 分片被追加到数组里比它小的版本号（乱序）；② 某库先应用了高号、低号此后才进仓（跳号）。
 *   ① 本用例直接判红。② **判不了**（清单是静态 import，测不到"未来的仓里少一条"），
 *   只能靠 `migrations-list-v43.ts` 文件头那块发版拦路牌 + 发版前逐条点名确认。
 *   ⚠️ 刻意**不**断言「1..max 无空洞」：v42 此刻在同仓另一会话手里尚未提交，那条锁会让 CI
 *   替别人的在途批变红（全仓红的归属要分开记，见 CHANGELOG 惯例）。
 */
describe('storage/db — 迁移清单形状', () => {
  it('版本号严格升序且无重复（追加错分片顺序会被这里逮住）', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    let prev = 0;
    for (const v of versions) {
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('v43 确实在清单里（漏挂聚合出口＝表永不存在，症状是运行时 `no such table`）', () => {
    expect(MIGRATIONS.some((m) => m.version === 43)).toBe(true);
  });

  it('每条迁移的语句数组非空（空数组会白占一个版本锚点，回放测试据此判"已应用"却什么都没建）', () => {
    for (const m of MIGRATIONS) expect(m.statements.length).toBeGreaterThan(0);
  });
});
