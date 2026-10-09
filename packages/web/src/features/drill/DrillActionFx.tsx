/** Action-specific silhouettes: pages enter a book; a known word splits along one blade. */
export function DrillActionFx({ kind, term, event }: { kind: 'keep' | 'slay'; term: string; event: number }) {
  return <div className={`drill-fx drill-action-fx drill-action-${kind}`} key={event} aria-hidden="true">
    {kind === 'keep' ? <>
      <div className="drill-archive-pages">{Array.from({ length: 6 }, (_, i) => <i key={i} />)}</div>
      <div className="drill-archive-book">
        <svg viewBox="0 0 96 80" shapeRendering="crispEdges" focusable="false">
          <path className="archive-cover" d="M8 20h28l12 8 12-8h28v44H60l-12 8-12-8H8z" />
          <path className="archive-paper" d="M16 12h20l12 8 12-8h20v44H60l-12 8-12-8H16z" />
          <path className="archive-lines" d="M48 20v44M24 24h12m-12 8h12m-12 8h12m24-16h12m-12 8h12m-12 8h12" />
          <path className="archive-seal" d="M64 44h20v20H64zM68 52l4 4 8-8" />
        </svg>
      </div>
      <div className="drill-action-label"><b>已收入词库</b><span>{term}</span></div>
    </> : <>
      <div className="drill-cleaved-word"><span>{term}</span><span>{term}</span></div>
      <i className="drill-cut-blade" /><i className="drill-cut-scar" />
      <div className="drill-cut-chips">{Array.from({ length: 8 }, (_, i) => <i key={i} />)}</div>
      <div className="drill-action-label"><b>斩</b><span>今天不再出</span></div>
    </>}
  </div>;
}
