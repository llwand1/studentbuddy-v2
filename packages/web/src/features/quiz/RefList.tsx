/**
 * RefList — 本次出题的参考来源清单（契约 `docs/QUIZ-SEARCH-SPEC.md` §2.8）。
 *
 * 三条件决定长这样：
 * ① **默认折叠**——出题主场景是做题，来源是可核验的补充证据，不该顶掉题目（体验优先）；
 * ② 空清单返 null——没联网/没命中时由 `searchNote` 那句兜底，这里再说一遍就是重复；
 * ③ **URL 全部来自服务端映射的真实检索结果**，本组件只渲染，不拼链接、不补全、不发明来源。
 * 题库页与对话页共用（两页各写一遍必然漂成两种样式）。
 */
import type { QuizRef } from '@sb/shared';
import './ref-list.css';

export function RefList({ refs }: { refs: QuizRef[] }) {
  if (refs.length === 0) return null;
  return (
    <details className="quiz-refs">
      <summary>联网：本次参考了 {refs.length} 条资料</summary>
      <ul>
        {refs.map((r) => (
          <li key={r.n}>
            <span className="n">[{r.n}]</span>
            {r.url ? (
              <a href={r.url} target="_blank" rel="noreferrer noopener">
                {r.title}
              </a>
            ) : (
              <span>{r.title}</span>
            )}
            <span className="p">{r.provider}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
