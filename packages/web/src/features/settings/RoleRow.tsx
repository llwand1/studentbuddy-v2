/**
 * RoleRow — 角色模型绑定表的一行（服务商下拉 + 模型名输入 + 保存）。
 *
 * ★ **为什么从 `SettingsView.tsx` 拆出来**：本批加「词条朗读」分区后该文件触
 *   `web/.tsx ≤300` 红线（此前正 300 行、贴着线）。按仓规**拆文件不压注释**；
 *   判据＝**内聚的小 UI 块 → 独立组件**（同 `GrillPill.tsx` / `AttachmentTray.tsx` 先例）。
 * ★ `ProviderRow` 类型随组件一起搬来并 export：它是这一行 props 的形状，
 *   留在 `SettingsView` 会变成「组件在 A 文件、它的 props 类型在 B 文件」的隐性耦合。
 */
import { useState } from 'react';

export type ProviderRow = {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  streamMode?: 'stream' | 'once';
  /**
   * 归属（M2c，契约 `docs/TENANCY-SPEC.md` §8.1）：`null` = **平台通道**（老板出的钱），
   * 非 null = 我自带的 key。★ 平台的 provider **必须可见**（否则没法把角色绑到免费额度上），
   * 但**不可改**——改了会影响全站所有用户的默认模型，服务端会回 403。
   * 故这里据此把「回答形态」下拉与「删除」按钮禁掉：让用户看见限制，而不是点下去撞一个错误。
   */
  ownerId?: string | null;
};

export function RoleRow({
  label,
  providers,
  modelsMap,
  initialProvider,
  initialModel,
  onBind,
}: {
  label: string;
  providers: ProviderRow[];
  modelsMap: Record<string, string[]>;
  initialProvider: string;
  initialModel: string;
  onBind: (providerId: string, model: string) => void;
}) {
  const [pid, setPid] = useState(initialProvider || providers[0]?.id || '');
  const [model, setModel] = useState(initialModel);
  const models = modelsMap[pid] ?? [];
  return (
    <tr>
      <td>{label}</td>
      <td>
        <select value={pid} onChange={(e) => setPid(e.target.value)}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          placeholder="模型名（可手填或从列表选）"
          value={model}
          list={`models-${pid}`}
          onChange={(e) => setModel(e.target.value)}
        />
        <datalist id={`models-${pid}`}>
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </td>
      <td>
        <button className="settings-add" onClick={() => onBind(pid, model)} disabled={!pid}>
          保存
        </button>
      </td>
    </tr>
  );
}
