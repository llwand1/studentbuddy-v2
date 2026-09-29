/**
 * TermRelations — 词条页里展开的「关联」：AI 后台整理出的前置／组成／例子／易混淆关系（Step 3 关系图）。
 * ★ 同一份关系也喂给对话检索（问一个词条时把它的前置与易混淆一起带上），这里让学习者看得见、查得到。
 */
import { useEffect, useState } from 'react';
import type { TermRelationView } from '@sb/shared';
import { aiOpsApi } from '../../lib/api-ai-ops';

export function TermRelations({ termId }: { termId: string }) {
  const [items, setItems] = useState<TermRelationView[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    aiOpsApi
      .relations(termId)
      .then((r) => live && setItems(r.items))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [termId]);

  if (failed) return <div className="term-rel term-rel-empty">关联读取失败，稍后再试</div>;
  if (!items) return <div className="term-rel term-rel-empty">读取关联…</div>;
  if (items.length === 0) {
    return <div className="term-rel term-rel-empty">还没有整理出关联。新词条入库后，AI 会在后台把它和已有词条连起来。</div>;
  }
  return (
    <ul className="term-rel" aria-label="关联词条">
      {items.map((r) => (
        <li key={`${r.relation}-${r.termId}-${r.outgoing ? 1 : 0}`} className={`term-rel-item rel-${r.relation}`} title={r.note || undefined}>
          <span className="term-rel-k">{r.label}</span>
          {r.term}
        </li>
      ))}
    </ul>
  );
}
