/**
 * world/Chapter — 冒险录的一章：章名（CSS 按 :lang 双语生成）+ 标题 + 引言 + 演示内容。
 * 章名不进 DOM 文本，是为了让读屏只读真正的标题；纹饰与编号全在 `world.css`。
 */
import type { ReactNode } from 'react';

export function Chapter(props: { id: string; title: string; accent: string; lead: string; children: ReactNode }) {
  return (
    <section className={`wf-chapter wf-ch-${props.id}`} aria-label={`${props.title}${props.accent}`}>
      <header className="wf-head">
        <h2 className="wf-h2">
          {props.title}
          <span className="wf-accent">{props.accent}</span>
        </h2>
        <p className="wf-lead">{props.lead}</p>
      </header>
      {props.children}
    </section>
  );
}
