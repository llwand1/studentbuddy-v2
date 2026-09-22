/**
 * pk-boards — `PkJourney` 那一节的**七块屏态积木 + 机身**：产品的对战屏态原样搬进来。
 *
 * ★ 2026-09-22 双语批把本文件拆成两半（原来 297/300 行，双语化必然撞 gates 的行数墙）：
 *   文案 → `./pk-copy.ts`，五帧的表 → `./pk-frames.tsx`，**屏态积木与产品的代码对应留在本文件**。
 *
 * ★ 样式与动效**直接吃产品**：本文件 `import '../features/pk/pk.css'`，每块屏用产品的页面容器
 *   类 `sb-pk`（一个 `.sb-pk` = 一块屏），`<PkQuizPending/>`／`<PkVerdict/>` 是产品组件本身。
 *   先例：`demo/GraphDemo.tsx:39` 直接 import 产品的 `graph.css` 并使用产品的类名。
 *   ⇒ 「演示效果 ≠ 实际效果」这条风险在这里是**结构上不存在**的：同一份 CSS、同一份组件，
 *     呼吸点/骨架扫光/判定弹入都不再抄第二遍（唯一来源 pk.css:1024-1101），
 *     该文件末尾那条 `prefers-reduced-motion` 也自动罩住本节。
 *
 * ★ 货对板逐条核过（老板 2026-09-21：实际效果与演示效果差别不要太大）——每一块屏态都指得出
 *   产品代码，五帧之外没有一个字段是我编的：
 *     「AI 出题中…」/「冷却中」/「出题」= `PkQuizBlock.tsx:85`（三态互斥，同一条判据）
 *     「对手正在出题」+ 呼吸 + 骨架 +「已过 Ns」= `PkQuizPending.tsx:19-37`（服务端
 *       `quizPending` 只带「谁在出题」，**绝不预带题目内容**，PK-SPEC §13.1）
 *     「轮到你答」+ 45s 递减 = `PkAnswerBlock.tsx:30-34`（时限来自服务端 `deadlineAt`；产品还有「≤10s 变红变粗」
 *       一档，一帧 2.5 秒走不到那里 ⇒ 刻意不搬，见 `Answer`）
 *     「等待对手作答…」+ 同一个剩余秒 = `PkMatch.tsx:251-261`
 *     「答对 +2」= 私有回包（`PkMatch.tsx:151-152`），2.5s 自动消失（`VERDICT_MS:53`）
 *     「答对 +2 · 正确答案 B」= 折叠区「已判定」行（`PkMatch.tsx:271`），来自公开快照
 *     成功出题 +1 / 答对 +2 = `match.ts:107` 与 `match.ts:275`（契约 §1 的唯一计分事实源）
 *     主题轮转 = `advanceTopic`（`match.ts:226`，**成功出题那一刻**就切，不等这题答完）
 *     主题归属那一行 = `pk-view.ts:105-109` 的 `topicOwnerLabel`：**按看这块屏的人**算
 *       （自己的主题写「你的主题」，对方的写「`<昵称>` 的主题」）⇒ 同一秒钟两块屏这一行
 *       **必然不一样**；两块屏写成同一个词就是拿上帝视角画产品，所以每块屏传的是 `viewerOwns`
 *     两侧各一条独立 60s 冷却 = `nextQuizAt` 按 userId 分键（`match.ts:145`）
 *   ★ 三处压缩/省略，全部写在页面上那行 `.landing-jnote` 里，不藏在注释里：
 *     ① 时间：真一局 8 分钟、冷却 60 秒、答题 45 秒 ⇒ 这里一圈 12.5 秒。冷却因此只画
 *        「冷却中」这个**态**、不画剩余秒数（画了就会和压缩后的圈时对不上）。
 *     ② 折叠区在产品里**默认收起**（`PkMatch.tsx:85` `open=false`）⇒ 这里为了让人看见
 *        「正确答案 B」那一行，画成展开态。
 *     ③ 第二道题只画「轮到我答」与判分那两帧，中间那 40 多秒按同一条规则在跑、没画。
 *   ★ 刻意**没做**的一件事：产品里点选项即提交，没有「选中待提交」这个态 ⇒ 本段四个选项一律不带任何高亮，「他选的是 B」交给下一帧的判词去说。
 *
 * ★ 2026-09-22 中英切换批：文案搬到 `./pk-copy`（组件里不留中文字面量），五帧的表拆去 `./pk-frames.tsx`。
 *   ★ 语言一律由**每块积木自己** `useLandingLang()` 取——不在帧闭包里取：帧的 `mine/his` 是在
 *   `PkJourney` 的渲染中被调用的普通函数，在那里调 hook 等于跨组件调 hook。
 */
import type { ReactNode } from 'react';
import { HELP_PER_MATCH } from '@sb/shared';
import { PkQuizPending } from '../features/pk/PkQuizPending';
import { PkVerdict } from '../features/pk/PkVerdict';
import { useLandingLang, type Bi, type LandingLang } from './landing-lang';
import { T, answered, helps, judgedLine, pendingHint, pendingSec, quizHint, type DemoQuestion } from './pk-copy';
import '../features/pk/pk.css';

/** 主题条（`PkTopicBar.tsx:19-23` 的三个 span）。★ 归属那一行是**按看这块屏的人**算的，
    不是全局常量：产品走 `pk-view.ts:105-109` 的 `topicOwnerLabel`——主题属于自己时写
    「你的主题」，属于对方时写「`<对手昵称>` 的主题」（模板里那个空格是产品自己带的）。
    ⇒ 同一秒钟两块屏上这一行**必然不一样**；两块屏写成同一个词就是拿上帝视角画产品。 */
export function Topic({ topic, viewerOwns }: { topic: Bi; viewerOwns: boolean }) {
  const { lang } = useLandingLang();
  return (
    <div className="sb-pk-topic">
      <span className="sb-pk-topic-label">{T.roundTopic[lang]}</span>
      <span className="sb-pk-topic-name">{topic[lang]}</span>
      <span className="sb-pk-topic-owner">{viewerOwns ? T.yourTopic[lang] : T.rivalTopic[lang]}</span>
    </div>
  );
}

/** 出题区三态（`PkQuizBlock.tsx:85`）。控件一律用 span：整块屏 `pointer-events:none`，
    既不会造出点了没反应的死控件，样式仍是产品的。冷却剩余秒数刻意不画，理由见头注 ① */
export function QuizBox({ topic, state, prompt }: { topic: Bi; state: 'busy' | 'cooldown' | 'ready'; prompt: Bi }) {
  const { lang } = useLandingLang();
  const button = state === 'busy' ? T.aiQuizing[lang] : state === 'cooldown' ? T.cooldown[lang] : T.send[lang];
  return (
    <section className="sb-pk-card">
      <div className="sb-pk-q-head">
        <span className="sb-pk-h2">{T.setForRival[lang]}</span>
      </div>
      <p className="sb-pk-hint">{quizHint(topic[lang], lang)}</p>
      <div className="sb-pk-kind-row">
        <span className="sb-pk-btn tiny on">{T.single[lang]}</span>
        <span className="sb-pk-btn tiny">{T.trueFalse[lang]}</span>
      </div>
      <div className="sb-pk-form">
        <span className="sb-pk-input">{prompt[lang]}</span>
        <span className="sb-pk-btn primary">{button}</span>
      </div>
    </section>
  );
}

/** 答题区（`PkAnswerBlock.tsx:28-56`）。`.urgent`（≤10s）那一档本段走不到 ⇒ 不搬，见头注 */
export function Answer({ q, left }: { q: DemoQuestion; left: number }) {
  const { lang } = useLandingLang();
  return (
    <section className="sb-pk-card">
      <div className="sb-pk-q-head">
        <span className="sb-pk-h2">{T.yourTurn[lang]}</span>
        <span className="sb-pk-deadline">{left}s</span>
      </div>
      <p className="sb-pk-stem">{q.stem[lang]}</p>
      <div className="sb-pk-options">
        {q.options[lang].map((opt, i) => (
          <span className="sb-pk-option" key={i}>
            <span className="sb-pk-option-letter">{'ABCD'[i]}</span>
            <span className="sb-pk-option-text">{opt}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

/** 我出的题在他手上时，我这侧的样子（`PkMatch.tsx:251-261`） */
export function Waiting({ q, left }: { q: DemoQuestion; left: number }) {
  const { lang } = useLandingLang();
  return (
    <section className="sb-pk-card">
      <div className="sb-pk-q-head">
        <span className="sb-pk-hint">{T.waitingRival[lang]}</span>
        <span className="sb-pk-deadline">{left}s</span>
      </div>
      <p className="sb-pk-stem">{q.stem[lang]}</p>
    </section>
  );
}

/** 产品组件「对手正在出题」——呼吸点 + 三行骨架 + 真读数，一条都不自己画（见头注） */
export function Pending({ sec }: { sec: number }) {
  const { lang } = useLandingLang();
  return <PkQuizPending text={T.rivalSetting[lang]} sec={sec} secText={pendingSec(sec, lang)} hint={pendingHint(lang)} />;
}

/** 产品组件的判定横幅（私有回包，只给答的人看） */
export function Verdict() {
  const { lang } = useLandingLang();
  return <PkVerdict kind="correct" text={T.verdictCorrect[lang]} />;
}

/** 折叠区展开态的「已判定」（`PkMatch.tsx:263-290`）——正确答案只在判定后才随快照下发 */
export function Done({ rows }: { rows: Array<{ q: DemoQuestion; answer: number }> }) {
  const { lang } = useLandingLang();
  return (
    <div className="sb-pk-fold">
      <span className="sb-pk-fold-btn">
        <span className="sb-pk-fold-caret">{T.collapse[lang]}</span>
        <span className="sb-pk-fold-sum">
          {T.judged[lang]} {rows.length}
        </span>
      </span>
      <div className="sb-pk-fold-body">
        <section className="sb-pk-card">
          <h2 className="sb-pk-h2">{T.judged[lang]}</h2>
          {rows.map(({ q, answer }) => (
            <div className="sb-pk-done" key={q.stem.en}>
              <span className="sb-pk-stem">{q.stem[lang]}</span>
              <span className="sb-pk-verdict ok">{judgedLine(answer, lang)}</span>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

/** 一圈 = 两道题：我出的一道（01→03）加他出的一道（04→05）⇒ 双方各自 +1 与 +2，每圈都 +3。
    加分时刻与头注里每条代码引用一一对应，不是我随手取的增长率 */
export const PK_SCORE = {
  mine: (lap: number, f: number) => 8 + lap * 3 + (f >= 1 ? 1 : 0) + (f >= 4 ? 2 : 0),
  his: (lap: number, f: number) => 6 + lap * 3 + (f >= 2 ? 2 : 0) + (f >= 3 ? 1 : 0),
};

/** 开局比分/答对数取真实对局会有的量级（不参与任何计算）；道具每局 `HELP_PER_MATCH = 1` 个，这一圈没人用掉 */
export const PK_STAT = {
  mine: (f: number, lang: LandingLang) => answered(2 + (f >= 4 ? 1 : 0), 3 + (f >= 4 ? 1 : 0), lang),
  his: (f: number, lang: LandingLang) => answered(1 + (f >= 2 ? 1 : 0), 2 + (f >= 2 ? 1 : 0), lang),
};

/** 一块屏：产品的页面容器 `sb-pk` 原样用（一个 `.sb-pk` = 一块屏），外面只加一圈机身 */
export function Screen({ side, score, stat, children }: { side: Bi; score: number; stat: string; children: ReactNode }) {
  const { lang } = useLandingLang();
  return (
    <div className="landing-pk-screen">
      <div className="landing-pk-screen-head">
        <span className="landing-pk-side">{side[lang]}</span>
        <span className="landing-pk-meta">
          <span className="sb-pk-arena-score">{score}</span>
          <span className="sb-pk-sub">
            {stat} · {helps(HELP_PER_MATCH, lang)}
          </span>
        </span>
      </div>
      <div className="sb-pk landing-pk-screen-body">{children}</div>
    </div>
  );
}
