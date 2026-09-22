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
  /**
   * 秒数那一格的读法。**缺省 = 产品原句**（`已过 Ns` / `马上就好`），本仓唯一传它的地方是
   * 落地页那块双语演示屏（`app/pk-boards.tsx`）。留成可选而不是让演示另画一张卡：
   * 另画就要抄一遍骨架屏与呼吸点，两份必然漂（那正是老板要的「货不对板」）。
   */
  secText?: string;
  /** 底部那句提示，同上（缺省即产品原句） */
  hint?: string;
}

export function PkQuizPending({ text, sec, secText, hint }: Props) {
  return (
    <section className="sb-pk-card sb-pk-pending">
      <div className="sb-pk-pending-head">
        <span className="sb-pk-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="sb-pk-pending-text">{text}</span>
        <span className="sb-pk-pending-sec">{secText ?? (sec > 0 ? `已过 ${sec}s` : '马上就好')}</span>
      </div>
      <div className="sb-pk-skeleton" aria-hidden="true">
        <span className="sb-pk-sk-line w70" />
        <span className="sb-pk-sk-line w92" />
        <span className="sb-pk-sk-line w55" />
      </div>
      <p className="sb-pk-hint">{hint ?? '题目一出来就自动出现在这里，不用刷新'}</p>
    </section>
  );
}
