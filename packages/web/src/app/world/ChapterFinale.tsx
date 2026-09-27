/**
 * world/ChapterFinale — 冒险录终章：一句召唤 + 注册 CTA + 三条事实（开源 / 自带 Key / 数据自持）+ 源码入口。
 */
import { useLandingLang } from '../landing-lang';
import { FINALE as F } from './world-copy';
import { Chapter } from './Chapter';

export function ChapterFinale({ onCta }: { onCta: () => void }) {
  const { lang } = useLandingLang();
  return (
    <Chapter id="finale" title={F.title[lang]} accent={F.accent[lang]} lead={F.lead[lang]}>
      <div className="wz-gate">
        <i className="wz-rune wz-rune-l" aria-hidden="true" />
        <button type="button" className="landing-cta wz-cta" onClick={onCta}>{F.cta[lang]}</button>
        <i className="wz-rune wz-rune-r" aria-hidden="true" />
      </div>
      <ul className="wz-facts">
        {F.facts.map((x) => <li key={x.en}>{x[lang]}</li>)}
      </ul>
      <a className="wz-src" href="https://github.com/llwand1/studentbuddy-v2" target="_blank" rel="noreferrer noopener">
        {F.source[lang]} · github.com/llwand1/studentbuddy-v2
      </a>
    </Chapter>
  );
}
