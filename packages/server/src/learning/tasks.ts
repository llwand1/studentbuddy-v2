/**
 * learning/tasks.ts — 学习清单（用户向名称「任务清单」）：派单、判完成、发钥匙。
 * 契约 `docs/TERM-CARDS-SPEC.md` §4／§5，显示名改动见 §9。
 *
 * ★ **派单是规则派生，不是 LLM 生成**（这条是判决，不是偷懒）：
 *   三单的内容——"哪条词条差几张""哪条凉了""哪条候选待审"——**库里已经有答案**，
 *   让模型再判一次只会得到同一个答案，还要多付一次不确定的措辞。真正需要模型的是
 *   **词池扩容**（AI 生成 + 人工闸门，契约 §6），那一处确实是模型该干的。
 *   ⇒ UI 与文档一律不写"AI 为你生成了任务"，写"系统从你的进度里挑了三件事"。
 *   ⚠️ 本文件**不 import 任何 LLM 调用**——这是上面那句话唯一的技术保障。想改成 AI 派单，
 *   先删这段注释，别让文案与代码各说一套（demo 货不对板那条教训的同类）。
 *
 * ★★ **钥匙挂在 `status` 的翻转上，不挂在"完成"这件事上**（契约 §5 末条）：
 *   置 done 那条 UPDATE 带 `AND status = 'open'`，`changes === 1` 才发钥匙。
 *   ⇒ 多实例部署下同一个 tick 各跑一份也只会发一把（第二个写者看到的已经是 `done` 行，
 *   改不动、也就不发）。这是"定时器是进程内的"那条既有约束**唯一**能被代码兜住的地方。
 *
 * ★ 表名 `study_task` 而**不是** `task_item`：`shared/src/task-list.ts` 的 `TaskItem` 是
 *   聊天流里那条思考链进度面板，与这里毫无关系（同名会撞在同一个 barrel 里）。
 */
import { randomUUID } from 'node:crypto';
import { advanceDedupeKey, localDayKey, poolDedupeKey, unstallDedupeKey } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { cardsByTerm, type TermCards } from './term-cards.js';
import { drawablePool, grantEarnedKey } from './chest.js';

/** 一次最多挂几单没做完的。清单是"今天顺手做掉"的几件事，不是待办瀑布 */
export const MAX_OPEN_TASKS = 4;

/** 可抽池低于这个数才派"审候选"那一单（不低于就打扰人） */
export const POOL_LOW_WATER = 5;

/** 三类意图（ASCII 键，显示名在前端，同 `study_task.kind` 的判据） */
export type TaskKind = 'advance' | 'unstall' | 'review_pool';

export interface StudyTask {
  id: string;
  kind: TaskKind;
  title: string;
  why: string;
  termId: string | null;
  targetStar: number | null;
  done: boolean;
  createdAt: string;
  doneAt: string | null;
}

interface TaskRow {
  id: string;
  kind: string;
  title: string;
  why: string;
  term_id: string | null;
  ref_id: string | null;
  target_star: number | null;
  status: string;
  created_at: string;
  done_at: string | null;
}

const TASK_COLS = 'id, kind, title, why, term_id, ref_id, target_star, status, created_at, done_at';

function toTask(r: TaskRow): StudyTask {
  return {
    id: r.id,
    kind: r.kind === 'unstall' || r.kind === 'review_pool' ? r.kind : 'advance',
    title: r.title,
    why: r.why,
    termId: r.term_id,
    targetStar: r.target_star,
    done: r.status === 'done',
    createdAt: r.created_at,
    doneAt: r.done_at,
  };
}

/** 未完成的在前、按派单时间正序（用户第一眼看到的永远是"还能做的那几单"） */
export function listTasks(ownerId: string | null): StudyTask[] {
  const rows = getDb()
    .prepare(
      `SELECT ${TASK_COLS} FROM study_task WHERE owner_id = ?
        ORDER BY (status = 'done'), created_at ASC, rowid ASC`,
    )
    .all(ownerForWrite(ownerId)) as TaskRow[];
  return rows.map(toTask);
}

/** 派单时算出的意图：`INSERT OR IGNORE`，撞 `UNIQUE(owner_id, dedupe_key)` 就跳过 */
interface Intent {
  kind: TaskKind;
  dedupeKey: string;
  title: string;
  why: string;
  termId: string | null;
  refId: string | null;
  targetStar: number | null;
}

/** 标题里的词条名（一次性查；不进 `TermCards`——那张是纯读数，不该带文案） */
function termLabel(termId: string): string {
  const row = getDb().prepare('SELECT term FROM term_library WHERE id = ?').get(termId) as { term: string } | undefined;
  return row?.term ?? '这条词条';
}

/** 一星没封顶、且**已经过了 60%** 的词条优先——差一张就亮的东西最适合"今天顺手做掉"。
 *  并列按 id 升序：不排全序的话 `slice` 在并列处取谁不确定，同一个库两次派单会给出不同清单 */
function advanceIntents(cards: TermCards[]): Intent[] {
  return cards
    .filter((c) => c.progress.needed !== null && c.progress.nextStar !== null && c.progress.pct >= 0.6 && c.progress.needed <= 2)
    .sort((a, b) => b.progress.pct - a.progress.pct || a.termId.localeCompare(b.termId))
    .slice(0, MAX_OPEN_TASKS)
    .map((c) => {
      const target = c.progress.nextStar as number;
      return {
        kind: 'advance' as TaskKind,
        dedupeKey: advanceDedupeKey(c.termId, target),
        title: `把「${termLabel(c.termId)}」推到 ★${target}`,
        why: `还差 ${c.progress.needed} 张。聊到它、或者今天复习一次，都会各给一张。`,
        termId: c.termId,
        refId: null,
        targetStar: target,
      };
    });
}

/**
 * 停滞档：卡数停在 4～7（★1～★2、离 ★3 的 8 张差得看得见）。
 * ★ 这一类**不是**"再推一把"，而是"别让已经攒到的掉下去"——判据因此是
 *   **今天复习过一次**，不是卡数（卡数已经在那儿了，再涨反而不是这一单要的事）。
 * ⚠️ 今天已经复习过的直接跳过：否则会出现"派单的那一 tick 立刻判完成并发钥匙"，
 *   每六小时白送一把，而这单的意图（破停滞）根本没有发生过。
 * ⚠️ 也跳过已经被「推进」那一类选中的词条：同一条词同时挂"推到 ★3"和"别让凉掉"两单，
 *   看着像系统没想清楚自己要什么。推进的判据更强（差 ≤2 张），所以让它优先。
 */
function unstallIntents(ownerId: string | null, cards: TermCards[], today: string, skip: Set<string>): Intent[] {
  const owner = ownerForWrite(ownerId);
  const doneToday = new Set(
    (
      getDb()
        .prepare(
          `SELECT l.term_id AS id FROM term_review_log l JOIN term_library t ON t.id = l.term_id
            WHERE t.owner_id = ? AND l.reviewed_day = ?`,
        )
        .all(owner, today) as Array<{ id: string }>
    ).map((r) => r.id),
  );
  return cards
    .filter((c) => c.cards >= 4 && c.cards <= 7 && !doneToday.has(c.termId) && !skip.has(c.termId))
    .slice(0, 2)
    .map((c) => ({
      kind: 'unstall' as TaskKind,
      dedupeKey: unstallDedupeKey(c.termId),
      title: `别让「${termLabel(c.termId)}」凉掉`,
      why: `它停在 ${c.cards} 张已经不动了。今天复习一次就继续往前走。`,
      termId: c.termId,
      refId: null,
      targetStar: null,
    }));
}

/**
 * 补池：可抽的新词不够了，就派"审一条 AI 候选"。
 * ★ 判据是**那条候选被裁决过**（通过或驳回都算）——这一单要用户做的动作是**裁决**，
 *   不是"同意"。驳回也是把池子管起来，不裁决才是问题。
 */
function poolIntents(ownerId: string | null): Intent[] {
  const owner = ownerForWrite(ownerId);
  const poolLeft = drawablePool(ownerId).length;
  if (poolLeft >= POOL_LOW_WATER) return [];
  const rows = getDb()
    .prepare(
      `SELECT id, term, domain FROM term_pool_candidate
        WHERE owner_id = ? AND status = 'pending' AND decided_at IS NULL
        ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    )
    .all(owner) as Array<{ id: string; term: string; domain: string }>;
  return rows.map((c) => ({
    kind: 'review_pool' as TaskKind,
    dedupeKey: poolDedupeKey(c.term, c.domain),
    title: `审一条新词进宝箱：「${c.term}」`,
    why: `宝箱里能抽的新词只剩 ${poolLeft} 条了。通过它、或者明确否掉它，都算这单做完。`,
    termId: null,
    refId: c.id,
    targetStar: null,
  }));
}

export interface DispatchResult {
  added: number;
  taskIds: string[];
  /** 本次派单后还 open 的总数（前端据此判断要不要冒气泡：已经四单还派就是噪音） */
  openAfter: number;
}

/**
 * 派一轮单。★ 幂等：意图键里没有会变的数，同一件事重复 tick 只会撞 `UNIQUE`、不会堆行。
 * 挂在既有的 6 小时 tick 上（契约 §5），**不新建调度器**。
 */
export function dispatchTasks(ownerId: string | null, now = new Date()): DispatchResult {
  const owner = ownerForWrite(ownerId);
  const countOpen = (): number =>
    (getDb().prepare(`SELECT COUNT(*) AS n FROM study_task WHERE owner_id = ? AND status = 'open'`).get(owner) as {
      n: number;
    }).n;
  const room = Math.max(0, MAX_OPEN_TASKS - countOpen());
  const ids: string[] = [];
  if (room > 0) {
    const cards = [...cardsByTerm(ownerId).values()];
    const advance = advanceIntents(cards);
    const intents = [
      ...advance,
      ...unstallIntents(ownerId, cards, localDayKey(now), new Set(advance.map((a) => a.termId ?? ''))),
      ...poolIntents(ownerId),
    ];
    const db = getDb();
    const ins = db.prepare(
      `INSERT OR IGNORE INTO study_task
         (id, owner_id, kind, dedupe_key, title, why, term_id, ref_id, target_star, status, dispatched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', datetime('now'))`,
    );
    db.transaction(() => {
      for (const it of intents) {
        if (ids.length >= room) break;
        const id = randomUUID();
        const r = ins.run(id, owner, it.kind, it.dedupeKey, it.title, it.why, it.termId, it.refId, it.targetStar);
        if (r.changes === 1) ids.push(id); // ★ 撞 UNIQUE 的不算新增（去重键在干活）
      }
    })();
  }
  reconcileTasks(ownerId, now);
  return { added: ids.length, taskIds: ids, openAfter: countOpen() };
}

/** 判据求值：只读事实、不写库，所以每次 `/state` 重算都安全（完成口径全仓只有这一处） */
function isDone(row: TaskRow, ownerId: string | null, now: Date): boolean {
  if (row.kind === 'advance') {
    if (!row.term_id || row.target_star === null) return false;
    const c = cardsByTerm(ownerId).get(row.term_id);
    return !!c && c.star >= row.target_star;
  }
  if (row.kind === 'unstall') {
    if (!row.term_id) return false;
    return !!getDb()
      .prepare('SELECT 1 AS x FROM term_review_log WHERE term_id = ? AND reviewed_day = ? LIMIT 1')
      .get(row.term_id, localDayKey(now));
  }
  if (row.kind === 'review_pool') {
    if (!row.ref_id) return false; // ★ 没有 ref_id 就不许判完成：宁可这单挂着，也不要靠标题猜
    return !!getDb()
      .prepare(
        `SELECT 1 AS x FROM term_pool_candidate
          WHERE id = ? AND status IN ('approved','rejected') AND decided_at IS NOT NULL`,
      )
      .get(row.ref_id);
  }
  return false; // 未知 kind（将来加了新意图而忘了在这里判）⇒ 永不自证完成
}

export interface ReconcileResult {
  completed: string[];
  keysGranted: number;
}

/**
 * 重算 open 集：满足判据的置 done 并**各发一把钥匙**。
 * ★★ 发钥匙只在 `changes === 1` 时执行——文件头那条"翻转发钥匙"判据的落地点。
 */
export function reconcileTasks(ownerId: string | null, now = new Date()): ReconcileResult {
  const owner = ownerForWrite(ownerId);
  const db = getDb();
  const open = db
    .prepare(`SELECT ${TASK_COLS} FROM study_task WHERE owner_id = ? AND status = 'open'`)
    .all(owner) as TaskRow[];
  const flip = db.prepare(`UPDATE study_task SET status = 'done', done_at = datetime('now') WHERE id = ? AND status = 'open'`);
  const completed: string[] = [];
  let keysGranted = 0;
  db.transaction(() => {
    for (const r of open) {
      if (!isDone(r, ownerId, now)) continue;
      if (flip.run(r.id).changes !== 1) continue; // 已被别的写者翻过 ⇒ 不发第二把
      completed.push(r.id);
      keysGranted += 1;
      grantEarnedKey(ownerId, now);
    }
  })();
  return { completed, keysGranted };
}

export type CompleteResult = { ok: true; keyGranted: boolean } | { ok: false; reason: 'not_yet' | 'unknown' };

/**
 * 用户点「我做完了」。★ **判据仍由服务端算**——这一枚钮只是催一次重算；不满足就返回
 * `not_yet`，前端提示"还没到"，而不是默默发钥匙。
 * 不这么做的后果很直白：任何人发一个 POST 就能刷满钥匙，宝箱当天脱钩。
 */
export function completeTask(ownerId: string | null, taskId: string, now = new Date()): CompleteResult {
  const owner = ownerForWrite(ownerId);
  const row = getDb()
    .prepare(`SELECT ${TASK_COLS} FROM study_task WHERE id = ? AND owner_id = ?`)
    .get(taskId, owner) as TaskRow | undefined;
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.status === 'done') return { ok: true, keyGranted: false };
  const r = reconcileTasks(ownerId, now);
  const hit = r.completed.includes(taskId);
  return hit ? { ok: true, keyGranted: hit } : { ok: false, reason: 'not_yet' };
}
