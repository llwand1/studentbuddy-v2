/**
 * AttachmentTray — 待发送图片的预览托盘（v17 看图，2026-09-16 从 ChatComposer 抽）。
 *
 * 抽出来的理由：`ChatComposer.tsx` 贴 300 行门禁，v18 grill-me 又要往里加开关与提示条。
 * 这块是**自成一体的预览区**（只在有附件时渲染），搬走零行为改动——
 * 与本仓 `useChoiceQueue` / `useSendActions` / `GrillPill` 的处置同源。
 */
export function AttachmentTray({
  images,
  onRemove,
}: {
  images: Array<{ dataUrl: string; name?: string }>;
  onRemove: (index: number) => void;
}) {
  if (images.length === 0) return null;
  return (
    <div className="chat-attachments">
      {images.map((img, i) => (
        <div className="chat-att" key={i}>
          <img src={img.dataUrl} alt={img.name ?? '图片'} />
          <button type="button" className="chat-att-remove" aria-label="移除图片" onClick={() => onRemove(i)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
