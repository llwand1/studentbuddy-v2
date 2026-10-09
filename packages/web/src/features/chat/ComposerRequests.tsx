import { useEffect, useId, useState, type ComponentProps } from 'react';
import { useMobilePanel } from '../../lib/use-mobile-panel';
import { AskStyleCard } from './AskStyleCard';
import { ConfirmCard } from './ConfirmCard';
import { ChoiceCard } from './ChoiceCard';

type Ask = ComponentProps<typeof AskStyleCard>;
type Confirm = ComponentProps<typeof ConfirmCard>;
type Choice = ComponentProps<typeof ChoiceCard>;

/** One entry for actionable cards. Hidden cards stay mounted to retain local drafts. */
export function ComposerRequests({ ask, confirm, choice }: { ask: Ask | null; confirm: Confirm | null; choice: Choice | null }) {
  const id = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const cards = [
    ...(confirm ? [{ key: `confirm:${confirm.request.requestId}`, label: confirm.request.decision === null ? '等待确认' : '确认结果', node: <ConfirmCard {...confirm} /> }] : []),
    ...(choice ? [{ key: `choice:${choice.request.id}`, label: choice.request.status === 'pending' ? '等待选择' : '选择结果', node: <ChoiceCard {...choice} /> }] : []),
    ...(ask ? [{ key: 'ask', label: '出题偏好', node: <AskStyleCard {...ask} /> }] : []),
  ];
  const active = cards.find((card) => card.key === selected);
  const keys = cards.map((card) => card.key).join('|');
  useEffect(() => { if (!keys.split('|').includes(selected ?? '')) setSelected(null); }, [keys, selected]);
  const open = active !== undefined;
  useMobilePanel(open, () => setSelected(null));
  if (!cards.length) return null;
  const head = cards[0];
  const remaining = confirm && confirm.request.decision === null ? Math.max(0, Math.ceil((confirm.request.expiresAt - confirm.now) / 1000)) : null;
  const summary = confirm?.request.actionSummary ?? choice?.request.question ?? '选择本次出题的回答方式';
  return <section className="composer-requests" aria-label="AI 待办">
    <button type="button" className="composer-request-entry" aria-expanded={open} aria-controls={id}
      onClick={() => setSelected(open ? null : head?.key ?? null)}>
      <b>{head?.label}{cards.length > 1 ? ` · ${cards.length}` : ''}</b>
      <span className="composer-request-summary">{summary}</span>
      {remaining !== null && <span role="status">{remaining > 0 ? `${remaining}s` : '正在收口'}</span>}
      <span>{open ? '收起' : '查看'}</span>
    </button>
    <div id={id} className="composer-request-panel" hidden={!open}>
      {cards.length > 1 && <nav className="composer-request-tabs" aria-label="切换 AI 待办">
        {cards.map((card) => <button key={card.key} type="button" aria-pressed={selected === card.key} onClick={() => setSelected(card.key)}>{card.label}</button>)}
      </nav>}
      {cards.map((card) => <div key={card.key} hidden={card.key !== selected}>{card.node}</div>)}
    </div>
  </section>;
}
