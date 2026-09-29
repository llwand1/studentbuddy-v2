/**
 * DrillFx — 刷词的命中特效层（契约 `docs/WAIT-DRILL-SPEC.md` §5.3）。
 *
 * 五款答对特效轮换（每答对一次换下一款，让"变化"本身成为奖励），外加答错的碎裂与连击里程碑的大字：
 *   slash 斩击（百词斩式一刀两断的白刃）/ burst 像素爆裂（12 粒方块四散）/ star 星芒（四角星 + 冲击环）/
 *   bolt 电光（锯齿闪电描线）/ ink 血墨（不规则墨点炸开 + 三滴飞溅）。
 *
 * ★ 全部是 CSS 关键帧（`drill-fx.css`），组件只翻 class 与 `key`（同款连续触发靠换 key 重放）。
 * ★ 四条口径与对话页特效层同：只用 `steps()`；只动 transform / opacity / clip-path；**默认态即终态**
 *   （`prefers-reduced-motion` 下全局关动画后粒子 `opacity:0` 直接不存在）；`pointer-events:none`、`aria-hidden`。
 * ★ 粒子的方向 / 延迟全写在 `:nth-child` 规则里——仓规禁止内联 style，也不该为 12 粒方块生成 12 个类名。
 */

export type DrillFxKind = 'slash' | 'burst' | 'star' | 'bolt' | 'ink';

export const DRILL_FX_KINDS: readonly DrillFxKind[] = ['slash', 'burst', 'star', 'bolt', 'ink'];

export const DRILL_FX_LABEL: Record<DrillFxKind, string> = {
  slash: '斩击',
  burst: '爆裂',
  star: '星芒',
  bolt: '电光',
  ink: '血墨',
};

/** 第 n 次答对（从 1 数）用哪款：轮着来，五款都能见到 */
export function fxKindFor(correctCount: number): DrillFxKind {
  const n = Math.max(0, Math.trunc(correctCount) - 1);
  return DRILL_FX_KINDS[n % DRILL_FX_KINDS.length] ?? 'slash';
}

export interface DrillFxState {
  kind: DrillFxKind | 'wrong';
  /** 每次触发 +1：同款连续触发也能重放 */
  key: number;
  /** 连击里程碑（5、10…）：叠一层大字 */
  combo?: number;
}

const PARTICLES: Record<DrillFxKind, number> = { slash: 2, burst: 12, star: 2, bolt: 1, ink: 4 };

export function DrillFx({ fx }: { fx: DrillFxState | null }) {
  if (!fx) return null;
  if (fx.kind === 'wrong') {
    return (
      <div className="drill-fx drill-fx-wrong" key={fx.key} aria-hidden="true">
        <svg className="drill-fx-crack" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
          <path d="M50 0 L46 22 L58 38 L44 55 L56 74 L48 100" />
          <path d="M46 22 L28 30 M58 38 L78 34 M44 55 L22 66 M56 74 L80 82" />
        </svg>
      </div>
    );
  }
  const n = PARTICLES[fx.kind];
  return (
    <div className={`drill-fx drill-fx-${fx.kind}`} key={fx.key} aria-hidden="true">
      {fx.kind === 'bolt' ? (
        <svg className="drill-fx-boltline" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
          <path d="M52 0 L40 34 L58 40 L38 72 L60 66 L46 100" />
        </svg>
      ) : (
        Array.from({ length: n }, (_, i) => <i key={i} />)
      )}
      {fx.combo !== undefined && fx.combo > 0 && (
        <b className="drill-fx-combo">
          COMBO ×{fx.combo}
          <small>{DRILL_FX_LABEL[fx.kind]}</small>
        </b>
      )}
    </div>
  );
}
