/**
 * PkHistory — 对战历史（契约 docs/PK-SPEC.md §12.2，P0-8）。
 *
 * 列表（**我的视角**：对手、比分、胜负、怎么结束的）+ 点开看该局的题目回看。
 * 数据与错误由 `PkApp` 持有（与大厅共用一条 error 位，ADR-5），本组件只挂 UI；
 * 全部文案判定走 `pk-view.ts` 的纯函数（本仓 `.tsx` 无测试环境）。
 */
import type { PkMatchDetail, PkMatchRecord } from '@sb/shared';
import { finishTitle, formatEndedAt, outcomeLabel, reasonLabel } from './pk-view';
import { PkReviewList } from './PkReviewList';

interface Props {
  userId: string;
  /** null = 还没拉到（与「拉到空表」是两件事，不合并） */
  records: PkMatchRecord[] | null;
  detail: PkMatchDetail | null;
  loading: boolean;
  onOpen: (id: string) => void;
  onCloseDetail: () => void;
  onBack: () => void;
}

export function PkHistory({ userId, records, detail, loading, onOpen, onCloseDetail, onBack }: Props) {
  if (detail) {
    return (
      <>
        <section className="sb-pk-card">
          <div className="sb-pk-q-head">
            <h2 className="sb-pk-h2">{finishTitle(detail.snapshot, userId)}</h2>
            <span className="sb-pk-verdict">{reasonLabel(detail.reason, detail.outcome)}</span>
          </div>
          <div className="sb-pk-score">
            <div className="sb-pk-side me">
              <span className="sb-pk-nick">我</span>
              <span className="sb-pk-score-num">{detail.myScore}</span>
              <span className="sb-pk-sub">{detail.mode === 'pve' ? 'AI 对战' : '双人对战'}</span>
            </div>
            <div className="sb-pk-side">
              <span className="sb-pk-nick">{detail.opponentNickname}</span>
              <span className="sb-pk-score-num">{detail.oppScore}</span>
              <span className="sb-pk-sub">{formatEndedAt(detail.endedAt)}</span>
            </div>
          </div>
        </section>
        <section className="sb-pk-card">
          <h2 className="sb-pk-h2">回看题目</h2>
          <PkReviewList questions={detail.snapshot.questions ?? []} userId={userId} />
          <button type="button" className="sb-pk-btn" onClick={onCloseDetail}>
            返回列表
          </button>
        </section>
      </>
    );
  }

  return (
    <section className="sb-pk-card">
      <div className="sb-pk-q-head">
        <h2 className="sb-pk-h2">对战历史</h2>
        <span className="sb-pk-link">{records ? `${records.length} 局` : ''}</span>
      </div>
      {loading && <p className="sb-pk-hint">正在读取…</p>}
      {!loading && records?.length === 0 && (
        <p className="sb-pk-hint">还没有打完的对局。一局结束（时间到或有人认输）就会记在这里</p>
      )}
      {records?.map((r) => (
        <button key={r.id} type="button" className="sb-pk-hist-row" onClick={() => onOpen(r.id)}>
          <span className={r.outcome === 'win' ? 'sb-pk-hist-badge win' : 'sb-pk-hist-badge'}>
            {outcomeLabel(r.outcome)}
          </span>
          <span className="sb-pk-hist-main">
            {r.mode === 'pve' ? 'AI 对战' : '双人对战'} · vs {r.opponentNickname}
            <small>
              {reasonLabel(r.reason, r.outcome)} · {r.quizCount} 题 · {formatEndedAt(r.endedAt)}
            </small>
          </span>
          <span className="sb-pk-hist-score">
            {r.myScore} : {r.oppScore}
          </span>
        </button>
      ))}
      <button type="button" className="sb-pk-btn" onClick={onBack}>
        返回大厅
      </button>
    </section>
  );
}
