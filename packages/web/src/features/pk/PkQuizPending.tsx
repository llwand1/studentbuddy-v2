/**
 * PkQuizPending — 「对方正在出题」的过渡提示（UX 批，2026-09-15 老板点单）。
 *
 * ★ 为什么需要它：出题要 `await generateQuiz` **数秒**，这段时间答题方拿不到任何信号，
 *   题目只能「凭空出现」——老板实测原话：「在玩家看来，对面出题就是突然题目出现了」。
 *   服务端因此在 `PkRoomState.quizPending` 下发「谁在出题」，前端把这段等待**显式画出来**。
 *
 * ★ **只做呼吸 + 骨架屏，不做假进度条**：真的不知道还要几秒，画一根会走完的进度条等于
 *   撒谎——更糟的是它走完了题还没来，玩家会直接判定为卡死。改用「已过 Ns」这种真数字，
 *   等得越久、信息反而越明确（超过十几秒他自然会意识到这次生成慢了）。
 */
interface Props {
  /** 展示文案（'AI 正在出题' / '对手正在出题'），由 `quizPendingLabel` 给出 */
  text: string;
  /** 已过秒数（真数字，来自 `quizPendingSec`） */
  sec: number;
}

export function PkQuizPending({ text, sec }: Props) {
  return (
    <section className="sb-pk-card sb-pk-pending">
      <div className="sb-pk-pending-head">
        <span className="sb-pk-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="sb-pk-pending-text">{text}</span>
        <span className="sb-pk-pending-sec">{sec > 0 ? `已过 ${sec}s` : '马上就好'}</span>
      </div>
      <div className="sb-pk-skeleton" aria-hidden="true">
        <span className="sb-pk-sk-line w70" />
        <span className="sb-pk-sk-line w92" />
        <span className="sb-pk-sk-line w55" />
      </div>
      <p className="sb-pk-hint">题目一出来就自动出现在这里，不用刷新</p>
    </section>
  );
}
