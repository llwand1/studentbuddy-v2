/**
 * GrillPill — grill-me 模式的「开着」提示条（v18，2026-09-16）。
 *
 * 为什么必须有它：模式开关收在「+」折叠菜单里，收进去就失去了可见性——
 * 用户会以为开关没生效。`composer-status.ts` 里「联网开着必说」是同一条规矩
 * （写错不报错、只是少一句提示，但用户会以为功能不存在）。
 */
export function GrillPill({ onClose }: { onClose: () => void }) {
  return (
    <div className="chat-grill-pill">
      追问模式：每轮先让你拍板，讲完再问下一步
      <button type="button" className="chat-grill-off" onClick={onClose}>
        关闭
      </button>
    </div>
  );
}
