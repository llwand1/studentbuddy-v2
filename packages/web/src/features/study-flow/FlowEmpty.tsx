/**
 * FlowEmpty — 「学习流」页的**未选流空态**（原先内联在 `FlowPage` 的 JSX 里）。
 *
 * ★ 为什么抽出来：`FlowPage.tsx` 已顶到 web 组件 **300 行**的红线（`AGENTS.md` 门禁 1），
 *   而本批要给它加一个「向 AI 追问」的透传 prop。按仓内既有纪律**拆文件、不压注释**
 *   （同 `app/SessionList.tsx` 的处置）。
 * ★ 纯展示、零 props：它解释的是"学习流是什么"，与页面任何状态都无关，本来就不该由
 *   `FlowPage` 承担。改文案只动这个文件，也不会影响 `FlowPage` 的行数预算。
 */
export function FlowEmpty() {
  return (
    <div className="fl-empty">
      <p>选一条学习流开始编排</p>
      <p className="fl-empty-sub">
        学习流 = 固定下来的一套学习顺序。每一步是一个学习交互体验（讲解/出题/判分/复盘/沉淀/总结），
        连线决定下一步跑哪个。
      </p>
    </div>
  );
}
