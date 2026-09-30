/** PK 音效开关：本机记忆，不影响对手；始终可见且可键盘操作。 */
export function PkSoundButton({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="sb-pk-sound-toggle"
      aria-pressed={enabled}
      aria-label={`对战音效${enabled ? '已开启' : '已关闭'}`}
      onClick={onToggle}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 9v6h4l5 4V5L8 9z" />
        {enabled ? <path d="M16 9a5 5 0 0 1 0 6M18.5 6.5a8.5 8.5 0 0 1 0 11" /> : <path d="m16 9 5 6m0-6-5 6" />}
      </svg>
      音效 {enabled ? '开' : '关'}
    </button>
  );
}
