/**
 * RoleRow — 角色模型绑定表的一行（服务商下拉 + **模型下拉** + 保存）。
 *
 * ★ **为什么从 `SettingsView.tsx` 拆出来**：本批加「词条朗读」分区后该文件触
 *   `web/.tsx ≤300` 红线（此前正 300 行、贴着线）。按仓规**拆文件不压注释**；
 *   判据＝**内聚的小 UI 块 → 独立组件**（同 `GrillPill.tsx` / `AttachmentTray.tsx` 先例）。
 * ★ `ProviderRow` 类型随组件一起搬来并 export：它是这一行 props 的形状，
 *   留在 `SettingsView` 会变成「组件在 A 文件、它的 props 类型在 B 文件」的隐性耦合。
 *
 * ── 2026-09-21 本批：模型从「手填 + datalist」改成**真下拉** ─────────────────
 * 老板原话：「直接根据服务商识别出有哪些可以选择的模型，然后直接用选项选」。
 * `datalist` 的问题不是不能用，而是**看起来像输入框**——用户不知道有候选、也不知道
 * 自己填的名字对不对（填错要等真发请求才报错）。改成 `select` 之后：
 *   · 候选就是**该服务商真实返回的模型**（服务端拉 `/models`），不会填出幽灵模型名；
 *   · 仍保留手填 —— 见下方「为什么留自定义」。
 *
 * ★ **为什么留自定义手填**（而不是纯下拉）：`/models` 有三个会返回空列表的现实情况——
 *   中转站不实现该端点、key 没配、网络不通。纯下拉在这三种情况下会把用户**锁死**
 *   （一个可选项都没有），而手填至少还能试。故列表为空时退化成纯输入框，
 *   有列表时多一个「自定义…」选项。
 */
import { useEffect, useState } from 'react';

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

/** 「自定义…」选项的哨兵值。用不可能撞上真实模型名的形态（真实模型名不会以 `__` 开头成对出现）。 */
const CUSTOM = '__custom__';

/** 「用默认模型」选项的哨兵值：空串 ⇒ 落库 model 为空 ⇒ 由平台默认模型决定（见 router.ts）。 */
const USE_DEFAULT = '';

export function RoleRow({
  label,
  providers,
  modelsMap,
  initialProvider,
  initialModel,
  onBind,
  onNeedModels,
}: {
  label: string;
  providers: ProviderRow[];
  modelsMap: Record<string, string[]>;
  initialProvider: string;
  initialModel: string;
  onBind: (providerId: string, model: string) => void;
  /** 选中一个**还没拉过**模型列表的服务商时回调（父组件据此按需拉，避免开屏就并发打 N 个请求） */
  onNeedModels?: (providerId: string) => void;
}) {
  const [pid, setPid] = useState(initialProvider || providers[0]?.id || '');
  const [model, setModel] = useState(initialModel);
  /** 用户主动选了「自定义…」 */
  const [custom, setCustom] = useState(false);
  const models = modelsMap[pid] ?? [];

  /**
   * ★★ **服务端值变了要跟着走**（2026-09-21 真机探针逮到的真 bug，见
   * `tools/probes/settings-platform-cdp.mjs` A9d 与 `RoleRow.test.tsx` 末尾那个 describe）。
   *
   * 现象：点「一键默认设置」，顶部绿色提示说「已一键配好 8 个角色：走免费通道，用 agnes-2.5-flash」，
   *   而下面绑定表里「讲解」那一行**仍显示旧服务商 + 旧模型**——服务端明明已经改了。
   *   用户看到的是**"点了没反应"**，接着他会去手改，把刚配好的覆盖掉。
   * 根因：`useState(initialProvider)` 只在**挂载时**取一次值，而父组件给的 key 是固定的
   *   `key={r.role}`（`SettingsView.tsx`），`reload()` 换了 props 也换不掉行内的 state。
   *   ★ 这类缺陷在 jsdom 单测"只渲染一次"的写法下**永远看不见**。
   * 修法：把 props 当**真相源**（而不是初始值）——服务端说什么，行上就显示什么。
   *
   * ★ 依赖刻意**只有这两个"服务端来的值"**：把 `providers` 也放进来，则每次添加/删除服务商
   *   （数组换引用）都会把**用户正在编辑的行**打回原状；故空值回落用函数式更新拿 `prev`。
   */
  useEffect(() => {
    // 服务端说"还没有绑定"（空串）时保留当前选择，不跳回第一个服务商——"没绑"和"换了"是两回事
    setPid((prev) => initialProvider || prev);
    setModel(initialModel);
    setCustom(false);
  }, [initialProvider, initialModel]);

  // ★ 当前值不在候选列表里（平台默认模型、或列表还没拉到时库里存的名字）⇒ 一律按"自定义"渲染。
  //   不这么判的话，`<select value="库里的名字">` 匹配不到任何 option，浏览器会**静默显示第一项**
  //   ——用户看到的是"绑的是 A"，实际存的是 B。这是本批最容易踩的一个显示层坑。
  // ★ 空串是**例外**：它不是一个"自定义值"，而是「用默认模型」这个**有明确选项**的合法状态
  //   （`models.includes('')` 恒为 false，不排除掉的话每个留空的角色都会莫名多出一个手填框，
  //   且下拉会显示成「自定义…」而不是「（用默认模型）」）。
  const showCustom = custom || (model !== '' && !models.includes(model));

  const changeProvider = (next: string) => {
    setPid(next);
    setCustom(false);
    // 没拉过就按需拉；已拉过的（含空数组＝拉过但没拉到）不重复打请求
    if (!modelsMap[next]) onNeedModels?.(next);
  };

  return (
    <tr>
      <td>{label}</td>
      <td>
        <select value={pid} onChange={(e) => changeProvider(e.target.value)}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </td>
      <td>
        {models.length > 0 ? (
          <>
            <select
              className="settings-model-select"
              value={showCustom ? CUSTOM : model}
              onChange={(e) => {
                if (e.target.value === CUSTOM) {
                  setCustom(true);
                  return;
                }
                setCustom(false);
                setModel(e.target.value);
              }}
            >
              {/* 空串 = 留空 ⇒ 交给平台默认模型（与「一键默认设置」写的是同一个值） */}
              <option value={USE_DEFAULT}>（用默认模型）</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value={CUSTOM}>自定义…</option>
            </select>
            {showCustom && (
              <input
                className="settings-model-input"
                placeholder="手填模型名"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            )}
          </>
        ) : (
          <input
            placeholder="模型名（没拉到候选列表，可手填）"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        )}
      </td>
      <td>
        {/* ★ 不再禁用"模型为空"：留空是**合法**配置（＝用平台默认模型），服务端已放行。
            禁用会让用户没法把某个角色从"我选的模型"改回"用默认"。 */}
        <button className="settings-add" onClick={() => onBind(pid, model)} disabled={!pid}>
          保存
        </button>
      </td>
    </tr>
  );
}
