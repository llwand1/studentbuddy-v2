/** A stepped, two-colour spell circuit; verdict text and marks remain the source of meaning. */
export function AnswerSpell() {
  return <svg className="answer-spell" viewBox="0 0 128 128" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
    <g className="answer-spell-orbit">
      <path d="M48 8h32v8h16v16h16v16h8v32h-8v16H96v16H80v8H48v-8H32V96H16V80H8V48h8V32h16V16h16z" />
      <path className="answer-spell-echo" d="M64 0v16m0 96v16M0 64h16m96 0h16M20 20l12 12m64 64 12 12M20 108l12-12m64-64 12-12" />
    </g>
    <g className="answer-spell-runes">
      <path d="M52 12h4v8h16v-8h4v12H52zM108 52h-8v4h8v16h-8v4h12V52zM52 104h24v12h-4v-8H56v8h-4zM16 52h12v4h-8v16h8v4H16z" />
      <path d="M28 28h8v8h-8zm64 0h8v8h-8zM28 92h8v8h-8zm64 0h8v8h-8z" />
    </g>
    <path className="answer-spell-prism" d="M64 28l36 36-36 36-36-36z" />
  </svg>;
}
