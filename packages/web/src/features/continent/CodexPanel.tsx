/**
 * features/continent/CodexPanel — 图鉴（题型排列组合的收集面板）。
 *
 * ★ 老板口径：**怪物的题目类型组合（5 种类型的排列）即图鉴条目**。故本面板展示的是
 *   「槽位 = 一个有序题型序列」，1 级 4 格 / 2 级 16 格 / 3 级 64 格（`scene` 落地后各自扩到 5/25/125）。
 * ★ **槽总数与槽内容全部由 `shared/continent.ts` 派生**（`codexSlotTypes` / `CONTINENT_CODEX_SLOTS`），
 *   本面板不写死 4/16/64，也不自己拼题型表——将来加题型时这里一行都不用改。
 * ★ 「已发现」的判据也是派生：有词条映射到该怪种**且有复习记录**（零存储，见 shared 头注）。
 *
 * ★ 宝箱 / 抽卡 / 稀有度是**显式空桩**（SPEC §4.2）：这里只呈现"未开放"与落地条件，
 *   **不建表、不复制 `rarityOf`、不复制 v45 四表**（唯一实现在未合分支 `feat/term-cards-game`）。
 */
import {
  CONTINENT_CHEST_ENABLED,
  CONTINENT_CHEST_NOTICE,
  CONTINENT_CODEX_SLOTS,
  CONTINENT_QLABEL,
  CONTINENT_QSHORT,
  codexSlotTypes,
} from '@sb/shared';

interface Props {
  /** 已发现的槽（来自 `buildContinentView().codexFound` 的集合） */
  found: ReadonlySet<number>;
  onClose: () => void;
}

export function CodexPanel({ found, onClose }: Props) {
  const slots = Array.from({ length: CONTINENT_CODEX_SLOTS }, (_, i) => i);
  return (
    <aside className="continent-codex" aria-label="图鉴">
      <header className="continent-codex-head">
        <span className="continent-modal-title">
          图鉴
          <small>
            已收集 {found.size} / {CONTINENT_CODEX_SLOTS} · 题型组合即图鉴条目
          </small>
        </span>
        <button className="continent-btn ghost" onClick={onClose}>
          收起
        </button>
      </header>

      <div className="continent-codex-grid">
        {slots.map((slot) => {
          const types = codexSlotTypes(slot);
          const on = found.has(slot);
          return (
            <span
              key={slot}
              className={on ? 'continent-codex-cell on' : 'continent-codex-cell'}
              title={`${types.map((t) => CONTINENT_QLABEL[t]).join(' + ')}${on ? '' : '（未发现）'}`}
            >
              {types.map((t, i) => (
                <i key={`${i}-${t}`} className={`continent-qtag ${t}`}>
                  {CONTINENT_QSHORT[t]}
                </i>
              ))}
            </span>
          );
        })}
      </div>

      <div className="continent-chest">
        <span className="continent-chest-icon" aria-hidden="true">
          {CONTINENT_CHEST_ENABLED ? '开' : '锁'}
        </span>
        <p>{CONTINENT_CHEST_NOTICE}</p>
      </div>
    </aside>
  );
}