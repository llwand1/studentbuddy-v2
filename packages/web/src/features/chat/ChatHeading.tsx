export function ChatHeading({ hidden, title, rounds }: { hidden: boolean; title?: string; rounds: number }) {
  return <div className={`chat-heading-slot${hidden ? ' is-hidden' : ''}`}>
    {!hidden && <header className="chat-head">
      <span className="chat-head-eyebrow">CAMPFIRE · 篝火对谈</span>
      <h2 className="chat-head-title">{title?.trim() || '新对话'}</h2>
      {rounds > 0 && <span className="chat-head-rounds">{rounds} 轮</span>}
    </header>}
  </div>;
}
