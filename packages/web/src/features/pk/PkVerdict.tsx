/**
 * PkVerdict — 判分反馈（UX 批，2026-09-15 老板点单「题目对错的动画反馈太少」）。
 *
 * 定位是**分层动效里的关键节点那一档**：答对弹入 + 绿、答错抖动 + 红、超时灰（不抖）。
 * 它替代了原来的 `flash` 一行纯文字——文字会读完就没了，带图标和颜色的整块反馈才留得住印象。
 *
 * ★ 图标是自绘 SVG 线条（本仓规矩：**禁 emoji 当图标**），24×24 viewBox、`stroke` 描边，
 *   与全局 line-icon 同一套手感。
 */
interface Props {
  /** `info` = 中性提示（错误原因／「已出类似题」这类），**不参与对错动画**——不能拿红叉配一句「求助失败」 */
  kind: 'correct' | 'wrong' | 'timeout' | 'info';
  /** 判分或提示文案，如「答对 +2」/「答错 −1」/「超时 −1」 */
  text: string;
}

/** 线条路径：对勾 / 叉 / 时钟指针（超时）/ 感叹号（中性提示） */
const ICON_PATH: Record<Props['kind'], string> = {
  correct: 'M4.5 12.5 L9.5 17.5 L19.5 6.5',
  wrong: 'M6.5 6.5 L17.5 17.5 M17.5 6.5 L6.5 17.5',
  timeout: 'M12 7.5 L12 12.5 L15.5 14.5',
  info: 'M12 10.5 L12 17 M12 7 L12 7',
};

export function PkVerdict({ kind, text }: Props) {
  return (
    <div className={`sb-pk-verdict-flash ${kind}`} role="status" aria-live="polite">
      <svg className="sb-pk-verdict-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="sb-pk-verdict-ring" cx="12" cy="12" r="9.5" />
        <path className="sb-pk-verdict-mark" d={ICON_PATH[kind]} />
      </svg>
      <span className="sb-pk-verdict-text">{text}</span>
    </div>
  );
}
