/**
 * PkForfeit — 投降 / 认输（契约 docs/PK-SPEC.md §12.1，P0-8）。
 *
 * 两段点选（先「投降」再「确认认输」）放在**本地**：投降不可撤销、误触代价是整局作废。
 * ★ 服务端**不加确认门**（`POST /rooms/:id/forfeit` 直通）——那里是幂等的状态转换，
 *   重复调用只会撞 409 `ROOM_NOT_ACTIVE`；把「确认」做成服务端规则，代价是 API 使用者
 *   以为功能不存在。一句话：**防误触是交互层的活，不是权限层的活。**
 */
import { useState } from 'react';

interface Props {
  busy: boolean;
  onForfeit: () => void;
}

export function PkForfeit({ busy, onForfeit }: Props) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <section className="sb-pk-card">
        <button type="button" className="sb-pk-btn danger" onClick={() => setConfirming(true)}>
          投降（认输）
        </button>
        <p className="sb-pk-hint">投降即对手胜、本局比分定格；不能撤销</p>
      </section>
    );
  }

  return (
    <section className="sb-pk-card">
      <h2 className="sb-pk-h2">确认认输？</h2>
      <p className="sb-pk-hint">点了就结束这一局：对手判胜，双方比分停在当前值（不退回、不额外扣分）</p>
      <div className="sb-pk-row">
        <button type="button" className="sb-pk-btn danger" disabled={busy} onClick={onForfeit}>
          {busy ? '提交中…' : '确认认输'}
        </button>
        <button type="button" className="sb-pk-btn" disabled={busy} onClick={() => setConfirming(false)}>
          继续打
        </button>
      </div>
    </section>
  );
}
