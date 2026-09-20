/**
 * FlowTopbar — 「学习流」页编辑区的**顶栏**：名字 / 版本 / 未保存标记 / 保存 / 一句话描述。
 *
 * ★ 为什么抽出来：`FlowPage.tsx` 已顶到 web 组件 **300 行**的红线（`AGENTS.md` 门禁 1），
 *   本批要给它加「向 AI 追问」的透传 prop。按仓内既有纪律**拆文件、不压注释**
 *   （同 `app/SessionList.tsx` 的处置）。
 * ★ 纯展示 + 三个回调：草稿态与保存流程**仍全在 `FlowPage`**（`edit` / `save` / `busy`），
 *   这里只负责把它们画出来。故「保存」按钮的可用判据（`!dirty || busy`）写在本文件，
 *   但**是否真的保存、保存什么**由 `onSave` 决定——本组件不碰请求。
 * ★ 名字与描述**受控**（`value` + `onChange` 回调到 `FlowPage.edit`）：草稿是页面的状态，
 *   本组件不留第二份副本（留了就会出现"顶栏显示 A、画布按 B 跑"的经典分叉）。
 */
export function FlowTopbar({
  name,
  description,
  version,
  dirty,
  busy,
  onName,
  onDescription,
  onSave,
}: {
  name: string;
  description: string;
  /** 库里那一版的版本号（保存成功后由服务端返回并更新） */
  version: number;
  /** 有未保存改动：决定「有未保存的改动」那句与「保存」按钮的可用态 */
  dirty: boolean;
  /** 有请求在途（保存/新建/克隆/删除共用同一个 busy） */
  busy: boolean;
  onName: (value: string) => void;
  onDescription: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <>
      <div className="fl-topbar">
        <input
          className="fl-name"
          value={name}
          placeholder="给这条流起个名字"
          onChange={(e) => onName(e.target.value)}
        />
        <span className="fl-ver">v{version}</span>
        {dirty && <span className="fl-dirty">有未保存的改动</span>}
        <button className="fl-btn primary" disabled={!dirty || busy} onClick={onSave}>
          保存
        </button>
      </div>
      <input
        className="fl-desc"
        value={description}
        placeholder="一句话说明这条流是干什么的（可留空）"
        onChange={(e) => onDescription(e.target.value)}
      />
    </>
  );
}
