/**
 * world/ChapterTerm — 冒险录「词条，一切力量的源头」：只放映词条那一段演示动画（抽词 → 高亮 → 复现）。
 */
import { useLandingLang } from '../landing-lang';
import { LandingDemo } from '../demo/LandingDemo';
import { TERM_FLOW } from '../demo/registry';
import { CH_TERM as C } from './world-copy';
import { Chapter } from './Chapter';

const ONLY_TERM = [TERM_FLOW];

export function ChapterTerm() {
  const { lang } = useLandingLang();
  return (
    <Chapter id="term" title={C.title[lang]} accent={C.accent[lang]} lead={C.lead[lang]}>
      <div className="wf-frame wt-demo">
        <LandingDemo demos={ONLY_TERM} />
      </div>
    </Chapter>
  );
}
