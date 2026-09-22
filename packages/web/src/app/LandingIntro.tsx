/**
 * app/LandingIntro — 落地页的**产品整体介绍**段（2026-09-22 落地页重排批新建；同日中英切换批文案外提）。
 *
 * ★★ 本组件对外渲染**两个 section，顺序即理解顺序**（2026-09-22 老板二次点单原文：
 *   「他是什么要在最前面，然后讲完之后才是词条」）：
 *   ① `.landing-intro-what` —— **它是什么**：类别、形态、给谁用、和普通聊天的区别；
 *   ② `.landing-intro-term` —— **词条是主体**：核心机制，五个去向。
 *
 * ★ 为什么必须拆成两段而不是合成一段：上一版两者混在同一段、甚至同一句话里——
 *   定义句第一句就是「把概念抽成词条」。后果是**读者在还没搞清这是什么的时候，
 *   先被塞了一个内部概念**：他还不知道这是个聊天框还是个笔记应用，就先听说了"词条库"。
 *   「类别 → 形态 → 机制」是理解顺序，反过来讲就是自说自话。
 *   ★ 这条顺序由 `Landing.test.tsx` 的「『它是什么』排在『词条是主体』之前」机器锁住：
 *     两块都在页面上、文本一个都不会少，只有 DOM 顺序能证明谁在前。
 *   ★ 双语批同一条锁换个方向也成立：`INTRO.def` 的英文侧**同样不许出现 "term"**——
 *     「定义句不塞内部概念」是版式纪律，不是只对中文生效的措辞巧合。
 *
 * ★ 为什么单独成一个组件而不是塞进 `Landing.tsx`：后者开工时已 294 行，而本仓
 *   `.tsx ≤300 行` 是 CI 硬红线（AGENTS.md「工程红线」）——不是"为了好看拆分"，是放不下。
 *   同样地，`TermJourney` / `PkJourney` 也是这个原因各自成文件的。
 *
 * ★ 介绍段**不谈价格、不谈竞品、不列功能清单**：这三样会把读者从「这是什么」
 *   推到「值不值得」，而在他还没搞清这是什么之前，后者答不上来。
 *
 * ★ 视觉纪律（AGENTS.md）：禁 emoji，图标用 `components/icons.tsx` 的自绘 line-icon；
 *   禁内联 style，一律走 `landing.css` 的 `.landing-intro-*`；
 *   列表类复用既有 `.landing-feature-icon / -title / -desc`（与 `PkJourney` 同口径：
 *   同一种列表样式不在第二个地方抄一遍）。
 */
import { LANDING_ICONS } from './landing-icons';
import { INTRO_TAGS, INTRO_THREE, TERM_SPINE } from './landing-data';
import { INTRO } from './landing-copy';
import { useLandingLang } from './landing-lang';

export function LandingIntro() {
  const { lang } = useLandingLang();
  return (
    <>
      {/* ① 它是什么 —— 整页第一个成段的东西，只讲类别与形态，一个内部概念都不许塞进来 */}
      <section className="landing-intro landing-intro-what" aria-label={INTRO.eyebrowWhat[lang]}>
        <p className="landing-intro-eyebrow">{INTRO.eyebrowWhat[lang]}</p>
        <h2 className="landing-h2 landing-intro-h2">
          {INTRO.h2Pre[lang]}
          <span className="landing-accent">{INTRO.h2Mid[lang]}</span>
          {INTRO.h2Tail[lang]}
        </h2>
        {/* ★ 定义句里**不出现「词条」**（英文侧同理不出现 term）：这一句的职责是让读者立刻知道
            "它属于哪一类东西"。机制由紧随其后的 `.landing-intro-term` 整段专讲。 */}
        <p className="landing-intro-def">{INTRO.def[lang]}</p>

        <div className="landing-intro-three">
          {INTRO_THREE.map(({ q, title, desc }) => (
            <div className="landing-intro-card" key={q.en}>
              <span className="landing-intro-q">{q[lang]}</span>
              <h4 className="landing-feature-title">{title[lang]}</h4>
              <p className="landing-feature-desc">{desc[lang]}</p>
            </div>
          ))}
        </div>

        {/* 信任标签条：不占正文位置，一行扫完 */}
        <ul className="landing-intro-tags">
          {INTRO_TAGS.map((t) => (
            <li key={t.en}>{t[lang]}</li>
          ))}
        </ul>
      </section>

      {/* ② 词条是主体 —— 讲完"它是什么"之后，才讲它靠什么运转（老板点单的主诉求） */}
      <section className="landing-intro landing-intro-term" aria-label={INTRO.h3TermAria[lang]}>
        <div className="landing-spine">
          <div className="landing-spine-head">
            <p className="landing-intro-eyebrow">{INTRO.eyebrowCore[lang]}</p>
            <h3 className="landing-intro-h3">
              {INTRO.h3Pre[lang]}
              <strong>{INTRO.h3Strong[lang]}</strong>
              {INTRO.h3Tail[lang]}
            </h3>
            <p className="landing-intro-lead">{INTRO.lead[lang]}</p>
          </div>
          <ol className="landing-spine-list">
            {TERM_SPINE.map(({ icon, title, desc }) => {
              const Icon = LANDING_ICONS[icon];
              return (
                <li className="landing-spine-item" key={title.en}>
                  <span className="landing-feature-icon landing-spine-icon">
                    <Icon size={18} />
                  </span>
                  <div className="landing-spine-text">
                    <h4 className="landing-feature-title">{title[lang]}</h4>
                    <p className="landing-feature-desc">{desc[lang]}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </section>
    </>
  );
}
