/**
 * features/continent/continent-dpad — 走位 D-pad（键盘之外的入口：触屏/鼠标玩家不该为了走一步去挂键盘）。
 *
 * ★ 2026-09-27 从 `ContinentPage.tsx` 拆出来：那份文件要守 gates 的「.tsx ≤300 行」红线，
 *   本次新增"选位态接线"后当场撞线。与 `continent-partners.tsx` 同一刀法——**一族功能一个文件**，
 *   页面只留编排（`onStep` / `onHalt` / `onRecenter` 都由页面注入，走位状态仍在 `useContinentHero`）。
 * ★ 长相一字未改（类名、`aria-label`、按钮顺序都照旧）：这不是重设计，只是搬家。
 */
interface Props {
  /** 走一步（`dr/dc` 是行/列的增量）——页面直连 `useContinentHero.step` */
  onStep: (dr: number, dc: number) => void;
  onHalt: () => void;
  /** 「回到我身上」：页面自增一次 = 按了一次（相机规则在 `useContinentCamera`，这里不碰相机） */
  onRecenter: () => void;
  /** 还要走几步（0 = 没排队） */
  queued: number;
}

export function ContinentDpad({ onStep, onHalt, onRecenter, queued }: Props) {
  return (
    <div className="continent-dpad" aria-label="走位">
      <button className="continent-btn ghost" onClick={() => onStep(-1, 0)} aria-label="向上走">
        ▲
      </button>
      <button className="continent-btn ghost" onClick={() => onStep(0, -1)} aria-label="向左走">
        ◀
      </button>
      <button className="continent-btn ghost" onClick={onHalt} aria-label="停下">
        停
      </button>
      <button className="continent-btn ghost" onClick={() => onStep(0, 1)} aria-label="向右走">
        ▶
      </button>
      <button className="continent-btn ghost" onClick={() => onStep(1, 0)} aria-label="向下走">
        ▼
      </button>
      <button className="continent-btn ghost" aria-label="回到我身上" onClick={onRecenter}>
        回到我身上
      </button>
      {queued > 0 && <span className="continent-dpad-queue">还要走 {queued} 步</span>}
    </div>
  );
}