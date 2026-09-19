/**
 * UndoDeleteBar — 词条页顶部「删除撤销条」（契约 docs/TOOL-ECOSYSTEM-SPEC.md §4.5，P3 拍板⑯⑰）。
 *
 * 为什么抽独立子组件：TermsPage 开工实测 279/300，撤销条本体连拉取带渲染约 90 行，
 * 塞进主页面必破线（契约 v1.4 行数订正点名，先例 GrantsList）。主页面只留挂线一行。
 *
 * 数据源 `GET /api/terms/delete-batches`（服务端 LIMIT 50，按批次最早时间倒序）：
 * 每批次一行「谁在几分钟前删了 N 条 + 撤销这 N 条」。**部分撤销如实报**：
 * 撞 (term,domain) 的快照服务端跳过并保留日志，这里念「还原 X 条，Y 条撞名未动」。
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { UndoableBatch } from '../../lib/api-tools';
import { parseMsgDate } from '../chat/chat-meta';

/** 批次时间人话：刚刚 / N 分钟前 / N 小时前 / M月D日 HH:mm（SQLite UTC 串走 parseMsgDate 统一解析） */
export function batchAgeText(createdAt: string, now: Date = new Date()): string {
  const d = parseMsgDate(createdAt);
  if (!d) return '';
  const mins = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 谁动的手：AI 工具点名到工具，UI 手滑说人话 */
export function batchActorText(b: UndoableBatch): string {
  if (b.actor === 'ui') return '你手动删除';
  return `AI 经 ${b.tool ?? '词条工具'} 删除`;
}

export function UndoDeleteBar({ onChanged, flash }: { onChanged: () => Promise<void>; flash: (m: string) => void }) {
  const [batches, setBatches] = useState<UndoableBatch[]>([]);
  const [busyBatch, setBusyBatch] = useState<string | null>(null);

  const reload = useCallback(() => {
    void api.terms
      .undoableBatches()
      .then(setBatches)
      .catch(() => setBatches([])); // 拿不到撤销条不等于页面坏了，静默空掉（ADR-5 只要求不装出"没有"，这里确实没有可显示的）
  }, []);

  useEffect(reload, [reload]);

  const undo = async (b: UndoableBatch) => {
    if (busyBatch) return;
    setBusyBatch(b.batch);
    try {
      const r = await api.terms.undoDelete(b.batch);
      flash(
        r.conflicts.length > 0
          ? `已撤销：还原 ${r.restored} 条，${r.conflicts.length} 条撞名未动`
          : `已撤销：还原 ${r.restored} 条`,
      );
      reload();
      await onChanged();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyBatch(null);
    }
  };

  if (batches.length === 0) return null;
  // 只浮最近 3 批：撤销条是应急出口不是账本，更早的批次仍然在（数据没截断，截的是展示）
  return (
    <div className="term-undo-bar">
      {batches.slice(0, 3).map((b) => (
        <div key={b.batch} className="term-undo-row">
          <span>
            {batchActorText(b)}
            {batchAgeText(b.createdAt) ? ` · ${batchAgeText(b.createdAt)}` : ''} · {b.count} 条
          </span>
          <button className="term-btn" disabled={busyBatch !== null} onClick={() => void undo(b)}>
            {busyBatch === b.batch ? '撤销中…' : `撤销这 ${b.count} 条`}
          </button>
        </div>
      ))}
      {batches.length > 3 ? <div className="term-undo-more">更早还有 {batches.length - 3} 个批次未列出</div> : null}
    </div>
  );
}
