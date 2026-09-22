/**
 * app/LandingFeatures — 落地页的**功能区**（2026-09-22 落地页重排批新建）。
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
import { TermJourney } from './TermJourney';
import { PkJourney } from './PkJourney';

export function LandingFeatures() {
  return (
    <section className="landing-zone" aria-label="功能介绍">
      <div className="landing-zone-head">
        <h2 className="landing-h2">
          它是<span className="landing-accent">怎么运转</span>的
        </h2>
        <p className="landing-section-sub">
          到这里你已经知道它是什么了。这一节按你上手后真实的先后顺序，一步一步走一遍——每一步底下挂的，是这一步里的一级功能入口。
        </p>
      </div>

      {/* ① 一步步动线：骨架。★ 编号取自数据的 `no`，不是渲染下标——编号是给读者看的路标，
          不能因为某天调了顺序就跟着变。 */}
      <ol className="landing-walk">
        {WALK.map(({ no, step, title, desc, caps }) => (
          <li className="landing-walk-step" key={no}>
            <div className="landing-walk-head">
              <span className="landing-walk-no">{no}</span>
              <span className="landing-walk-ring">{step}</span>
              <h3 className="landing-walk-title">{title}</h3>
            </div>
            <p className="landing-walk-desc">{desc}</p>
            <ul className="landing-walk-caps">
              {caps.map((cap) => {
                const Icon = LANDING_ICONS[cap.icon];
                return (
                  <li className="landing-walk-cap" key={cap.title}>
                    <span className="landing-feature-icon landing-walk-cap-icon">
                      <Icon size={16} />
                    </span>
                    <div>
                      <h4 className="landing-feature-title">{cap.title}</h4>
                      <p className="landing-feature-desc">{cap.desc}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>

      {/* ② 动线讲完，再放两屏真实界面的回放：先看一个词走完一整趟，再看同一份快照在两块屏上的读法 */}
      <p className="landing-section-sub landing-zone-lead">
        动线是骨架，下面两屏是它跑起来的样子 ——
      </p>
      <TermJourney />
      <PkJourney />

      {/* ③ 工程底牌：给懂行的人看的，排在最后（不看懂它也不影响前面怎么用） */}
      <div className="landing-zone-block" aria-label="工程品质">
        <h3 className="landing-zone-h3">
          工程上<span className="landing-accent">较真</span>
        </h3>
        <p className="landing-section-sub">差别不在于有没有接大模型，而在于闭环完整度、AI 输出可靠性、工程质量三层是否同时做实</p>
        <div className="landing-eng">
          {ENGINEERING.map(({ title, desc }) => (
            <div className="landing-eng-card" key={title}>
              <h4 className="landing-feature-title">{title}</h4>
              <p className="landing-feature-desc">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
