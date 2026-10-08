import type { ReactNode } from 'react';
import { LEARNING_CARDS, type LearningCardKind } from '../../lib/learning-card';
import './learning-reply.css';

/** 语义卡片只包装可信 React 节点；模型没有 HTML/CSS 控制权。 */
export function LearningReplyCard({ variant, title, children }: {
  variant: LearningCardKind; title: ReactNode; children: ReactNode;
}) {
  const info = LEARNING_CARDS[variant];
  return (
    <section className={`learning-reply-card learning-reply-${variant.toLowerCase()}`} aria-label={info.label}>
      <div className="learning-reply-head">
        <span className="learning-reply-mark" aria-hidden="true">{info.mark}</span>
        <span className="learning-reply-kind">{info.label}</span>
      </div>
      <h5 className="learning-reply-title">{title}</h5>
      <div className="learning-reply-body">{children}</div>
    </section>
  );
}
