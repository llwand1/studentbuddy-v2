/**
 * app/LandingFeatures — 落地页的**功能区**（2026-09-22 落地页重排批新建；同日中英切换批文案外提）。
 *
 * ★ 为什么抽出来：老板 2026-09-22 点单「雷点是先搞了功能介绍，而不是产品介绍」。
 *   抽文件的意义不在省行数，而在让**「介绍区」与「功能区」在 DOM 上成为两个可辨认的块**——
 *   这样下面那句「介绍必须在功能之前」才能被**机器断言**（见 `Landing.test.tsx` 的
 *   「介绍段排在功能区之前」那一条），而不是靠改的时候记得手别抖。
 *   ★ 顺序一旦塌回去没有人会报错：文案不会红、截图不会变、只有读者会觉得"这页在自说自话"。
 *
 * ★★ 本区内部的顺序（2026-09-22 老板二次点单「接下来的功能一步步讲」）：
 *   **一条编了号的动线（01 学 → 05 反馈）→ 两屏真实界面回放（词条旅程 / 对战）→ 工程底牌**。
 *   先给骨架再给例子：读者先拿到"我上手后会按什么顺序遇到什么"这条路标，
 *   再去看动起来的界面——否则两屏演示放最前面，看完只记得有个动画，不知道它在第几步。
 *   ★ 原先的「五环 + 九宫格」两张并列的表已合并成这一条动线（`landing-data.ts` 的 `WALK`）：
 *     九个入口各自挂在自己那一步底下，"一步步"才成立；两张表并列时读者只会记住"有 5 个环、还有 9 个功能"。
 *
 * ★ 视觉纪律（AGENTS.md）：禁 emoji / 禁内联 style / 图标走 `components/icons.tsx`。
 */
import { LANDING_ICONS } from './landing-icons';
import { ENGINEERING, WALK } from './landing-data';
import { FEATURES } from './landing-copy';
import { useLandingLang } from './landing-lang';
import { TermJourney } from './TermJourney';
import { PkJourney } from './PkJourney';

export function LandingFeatures() {
  const { lang } = useLandingLang();
  return (
    <section className="landing-zone" aria-label={FEATURES.aria[lang]}>
      <div className="landing-zone-head">
        <h2 className="landing-h2">
          {FEATURES.h2Pre[lang]}
          <span className="landing-accent">{FEATURES.h2Mid[lang]}</span>
          {FEATURES.h2Tail[lang]}
        </h2>
        <p className="landing-section-sub">{FEATURES.sub[lang]}</p>
      </div>

      {/* ① 一步步动线：骨架。★ 编号取自数据的 `no`，不是渲染下标——编号是给读者看的路标，
          不能因为某天调了顺序就跟着变。 */}
      <ol className="landing-walk">
        {WALK.map(({ no, step, title, desc, caps }) => (
          <li className="landing-walk-step" key={no}>
            <div className="landing-walk-head">
              <span className="landing-walk-no">{no}</span>
              <span className="landing-walk-ring">{step[lang]}</span>
              <h3 className="landing-walk-title">{title[lang]}</h3>
            </div>
            <p className="landing-walk-desc">{desc[lang]}</p>
            <ul className="landing-walk-caps">
              {caps.map((cap) => {
                const Icon = LANDING_ICONS[cap.icon];
                return (
                  <li className="landing-walk-cap" key={cap.title.en}>
                    <span className="landing-feature-icon landing-walk-cap-icon">
                      <Icon size={16} />
                    </span>
                    <div>
                      <h4 className="landing-feature-title">{cap.title[lang]}</h4>
                      <p className="landing-feature-desc">{cap.desc[lang]}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>

      {/* ② 动线讲完，再放两屏真实界面的回放：先看一个词走完一整趟，再看同一份快照在两块屏上的读法 */}
      <p className="landing-section-sub landing-zone-lead">{FEATURES.boards[lang]}</p>
      <TermJourney />
      <PkJourney />

      {/* ③ 工程底牌：给懂行的人看的，排在最后（不看懂它也不影响前面怎么用） */}
      <div className="landing-zone-block" aria-label={FEATURES.engAria[lang]}>
        <h3 className="landing-zone-h3">
          {FEATURES.engH2Pre[lang]}
          <span className="landing-accent">{FEATURES.engH2Mid[lang]}</span>
        </h3>
        <p className="landing-section-sub">{FEATURES.engSub[lang]}</p>
        <div className="landing-eng">
          {ENGINEERING.map(({ title, desc }) => (
            <div className="landing-eng-card" key={title.en}>
              <h4 className="landing-feature-title">{title[lang]}</h4>
              <p className="landing-feature-desc">{desc[lang]}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
