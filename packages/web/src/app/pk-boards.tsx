/**
 * pk-boards — `PkJourney` 那一节的**五帧 × 两块屏**：产品的对战屏态原样搬进来。
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
 *       **必然不一样**；两块屏写成同一个词就是拿上帝视角画产品，所以每帧传的是 `viewerOwns`
 *     两侧各一条独立 60s 冷却 = `nextQuizAt` 按 userId 分键（`match.ts:145`）
 *   ★ 三处压缩/省略，全部写在页面上那行 `.landing-jnote` 里，不藏在注释里：
 *     ① 时间：真一局 8 分钟、冷却 60 秒、答题 45 秒 ⇒ 这里一圈 12.5 秒。冷却因此只画
 *        「冷却中」这个**态**、不画剩余秒数（画了就会和压缩后的圈时对不上）。
 *     ② 折叠区在产品里**默认收起**（`PkMatch.tsx:85` `open=false`）⇒ 这里为了让人看见
 *        「正确答案 B」那一行，画成展开态。
 *     ③ 第二道题只画「轮到我答」与判分那两帧，中间那 40 多秒按同一条规则在跑、没画。
 *   ★ 刻意**没做**的一件事：产品里点选项即提交，没有「选中待提交」这个态 ⇒ 本段四个选项一律不带任何高亮，「他选的是 B」交给下一帧的判词去说。
 */
import type { ReactNode } from 'react';
import { HELP_PER_MATCH } from '@sb/shared';
import { PkQuizPending } from '../features/pk/PkQuizPending';
import { PkVerdict } from '../features/pk/PkVerdict';
import '../features/pk/pk.css';

const TOPIC_MINE = '圆周运动';
const TOPIC_HIS = '万有引力';
/* 出题框里那行字是**各人自己敲的**，所以四格按「谁 + 当前主题」命名：同一秒钟两块屏上的
   出题框可以同主题（主题是全房间共享的），但**不会是同一段话**——写成同一段就是复制粘贴了 */
const PROMPT_ME_ORBIT = '用「向心力的来源」出道单选题，别太简单';
const PROMPT_ME_GRAV = '出一道关于双星系统的单选题';
const PROMPT_HIM_GRAV = '出一个月球表面重力加速度的单选题';
const PROMPT_HIM_ORBIT = '用「圆锥摆」出道单选题';

/** 我出的那道（他答）。正确答案是第 2 个选项 ⇒ 判词写「正确答案 B」 */
const Q_MINE = {
  stem: '一个物块随圆盘一起做匀速圆周运动，使它获得向心力的是？',
  options: ['重力沿盘面的分量', '盘面对它的静摩擦力', '沿切面的「冲力」', '支持力'],
};
/** 他出的那道（我答）。正确答案是第 3 个选项 ⇒「正确答案 C」 */
const Q_HIS = {
  stem: '两颗星只在彼此的万有引力下绕共同质心做匀速圆周运动，一定相同的是？',
  options: ['轨道半径', '线速度', '周期', '质量'],
};

/** 帧内实时值：两侧共享同一个 `left`（同一份快照在两处的读数），`sec` 给「已过 Ns」 */
export type Live = { left: number; sec: number };

/** 主题条（`PkTopicBar.tsx:19-23` 的三个 span）。★ 归属那一行是**按看这块屏的人**算的，
    不是全局常量：产品走 `pk-view.ts:105-109` 的 `topicOwnerLabel`——主题属于自己时写
    「你的主题」，属于对方时写「`<对手昵称>` 的主题」（模板里那个空格是产品自己带的）。
    ⇒ 同一秒钟两块屏上这一行**必然不一样**；两块屏写成同一个词就是拿上帝视角画产品。 */
function Topic({ name, viewerOwns }: { name: string; viewerOwns: boolean }) {
  return (
    <div className="sb-pk-topic">
      <span className="sb-pk-topic-label">本轮主题</span>
      <span className="sb-pk-topic-name">{name}</span>
      <span className="sb-pk-topic-owner">{viewerOwns ? '你的主题' : '对手 的主题'}</span>
    </div>
  );
}

/** 出题区三态（`PkQuizBlock.tsx:85`）。控件一律用 span：整块屏 `pointer-events:none`，
    既不会造出点了没反应的死控件，样式仍是产品的。冷却剩余秒数刻意不画，理由见头注 ① */
function QuizBox({ topic, state, prompt }: { topic: string; state: 'busy' | 'cooldown' | 'ready'; prompt: string }) {
  return (
    <section className="sb-pk-card">
      <div className="sb-pk-q-head">
        <span className="sb-pk-h2">出题给对手</span>
      </div>
      <p className="sb-pk-hint">题目必须贴合本轮主题「{topic}」，跑题会被裁判判失败；成功 +1（60s 冷却）</p>
      <div className="sb-pk-kind-row">
        <span className="sb-pk-btn tiny on">单选</span>
        <span className="sb-pk-btn tiny">判断</span>
      </div>
      <div className="sb-pk-form">
        <span className="sb-pk-input">{prompt}</span>
        <span className="sb-pk-btn primary">{state === 'busy' ? 'AI 出题中…' : state === 'cooldown' ? '冷却中' : '出题'}</span>
      </div>
    </section>
  );
}

/** 答题区（`PkAnswerBlock.tsx:28-56`）。`.urgent`（≤10s）那一档本段走不到 ⇒ 不搬，见头注 */
function Answer({ q, left }: { q: typeof Q_MINE; left: number }) {
  return (
    <section className="sb-pk-card">
      <div className="sb-pk-q-head">
        <span className="sb-pk-h2">轮到你答</span>
        <span className="sb-pk-deadline">{left}s</span>
      </div>
      <p className="sb-pk-stem">{q.stem}</p>
      <div className="sb-pk-options">
        {q.options.map((opt, i) => (
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
function Waiting({ q, left }: { q: typeof Q_MINE; left: number }) {
  return (
    <section className="sb-pk-card">
      <div className="sb-pk-q-head">
        <span className="sb-pk-hint">等待对手作答…</span>
        <span className="sb-pk-deadline">{left}s</span>
      </div>
      <p className="sb-pk-stem">{q.stem}</p>
    </section>
  );
}

/** 折叠区展开态的「已判定」（`PkMatch.tsx:263-290`）——正确答案只在判定后才随快照下发 */
function Done({ rows }: { rows: { stem: string; text: string; ok: boolean }[] }) {
  return (
    <div className="sb-pk-fold">
      <span className="sb-pk-fold-btn">
        <span className="sb-pk-fold-caret">收起</span>
        <span className="sb-pk-fold-sum">已判定 {rows.length}</span>
      </span>
      <div className="sb-pk-fold-body">
        <section className="sb-pk-card">
          <h2 className="sb-pk-h2">已判定</h2>
          {rows.map(({ stem, text, ok }) => (
            <div className="sb-pk-done" key={stem}>
              <span className="sb-pk-stem">{stem}</span>
              <span className={ok ? 'sb-pk-verdict ok' : 'sb-pk-verdict'}>{text}</span>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

/** 一帧 = 两侧同一秒钟各自看到的屏态。★ 本轮主题不在这张表里当字段：它是**公开快照的一部分**、
    两侧同值，但「是谁的主题」按看屏的人算 ⇒ 交给每帧里那两个 `<Topic/>` 各自表态 */
export type PkFrame = {
  no: string;
  title: string;
  lead: string;
  desc: string;
  mine: (l: Live) => ReactNode;
  his: (l: Live) => ReactNode;
};

export const PK_FRAMES: PkFrame[] = [
  {
    no: '01',
    title: '我按下「出题」',
    lead: '生成的那几秒，他那块屏不是空白',
    desc: '出题要现场调模型生成，耗时数秒。服务端在落冷却的同时把「谁在出题」写进房间状态广播出去，对手立刻看到呼吸的三点、三行骨架和「已过 Ns」。不画假进度条——真的不知道还要几秒，画一根会走完的进度条等于撒谎。',
    mine: () => (
      <>
        <Topic name={TOPIC_MINE} viewerOwns />
        <QuizBox topic={TOPIC_MINE} state="busy" prompt={PROMPT_ME_ORBIT} />
      </>
    ),
    his: ({ sec }) => (
      <>
        <Topic name={TOPIC_MINE} viewerOwns={false} />
        <PkQuizPending text="对手正在出题" sec={sec} />
      </>
    ),
  },
  {
    no: '02',
    title: '题落到他屏上',
    lead: '同一个 45 秒，两副样子',
    desc: '他那边是「轮到你答」加四个选项；我这边这题只以一行「等待对手作答」出现，出题框已经在给下一题起草。两边显示的是同一个数——时限是服务端下发的时间戳，两块屏各自本地起表才会真的对不上。成功出题的 +1 在这同一瞬间到账，本轮主题也在这同一瞬间切给了他。',
    mine: ({ left }) => (
      <>
        <Topic name={TOPIC_HIS} viewerOwns={false} />
        <Waiting q={Q_MINE} left={left} />
        <QuizBox topic={TOPIC_HIS} state="cooldown" prompt={PROMPT_ME_GRAV} />
      </>
    ),
    his: ({ left }) => (
      <>
        <Topic name={TOPIC_HIS} viewerOwns />
        <Answer q={Q_MINE} left={left} />
      </>
    ),
  },
  {
    no: '03',
    title: '他交卷',
    lead: '判分那一刻，两侧看到的不一样',
    desc: '他那侧的「答对 +2」是这次请求的回包，只给他看、2.5 秒自动消失；我这侧只多出一行「已判定」和对手涨上去的分。正确答案要等题目判定完才随快照下发——判定之前它压根不在任何一方收到的数据里，所以答题时抄不到。',
    mine: () => (
      <>
        <Topic name={TOPIC_HIS} viewerOwns={false} />
        <QuizBox topic={TOPIC_HIS} state="cooldown" prompt={PROMPT_ME_GRAV} />
        <Done rows={[{ stem: Q_MINE.stem, text: '答对 +2 · 正确答案 B', ok: true }]} />
      </>
    ),
    his: () => (
      <>
        <Topic name={TOPIC_HIS} viewerOwns />
        <PkVerdict kind="correct" text="答对 +2" />
        <QuizBox topic={TOPIC_HIS} state="ready" prompt={PROMPT_HIM_GRAV} />
      </>
    ),
  },
  {
    no: '04',
    title: '角色互换',
    lead: '这次 45 秒落在我这侧',
    desc: '他按他的主题出好题，倒计时就落到我的屏上；等待的那块位置换成了他的，他的出题框已经进冷却。两侧各有一条互不相干的 60 秒冷却，所以谁也不必等谁——同一局里两个人可以随时同时出题、同时答题。主题此刻已经切回我这侧：它是出题成功那一刻换的，不是等谁答完才换。',
    mine: ({ left }) => (
      <>
        <Topic name={TOPIC_MINE} viewerOwns />
        <Answer q={Q_HIS} left={left} />
      </>
    ),
    his: ({ left }) => (
      <>
        <Topic name={TOPIC_MINE} viewerOwns={false} />
        <Waiting q={Q_HIS} left={left} />
        <QuizBox topic={TOPIC_MINE} state="cooldown" prompt={PROMPT_HIM_ORBIT} />
      </>
    ),
  },
  {
    no: '05',
    title: '一圈合上',
    lead: '两边的 +1 与 +2 都落到账上',
    desc: '我答对他出的那道，他那侧的「已判定」同样多出一行；一圈转完，双方各自拿到出题的 +1 与答对的 +2，两条比分同步往上走。一局 8 分钟就是这么一圈圈转出来的——转到时钟归零，才弹那一张结算面板。',
    mine: () => (
      <>
        <Topic name={TOPIC_MINE} viewerOwns />
        <PkVerdict kind="correct" text="答对 +2" />
        <QuizBox topic={TOPIC_MINE} state="cooldown" prompt={PROMPT_ME_ORBIT} />
      </>
    ),
    his: () => (
      <>
        <Topic name={TOPIC_MINE} viewerOwns={false} />
        <Done
          rows={[
            { stem: Q_MINE.stem, text: '答对 +2 · 正确答案 B', ok: true },
            { stem: Q_HIS.stem, text: '答对 +2 · 正确答案 C', ok: true },
          ]}
        />
      </>
    ),
  },
];

/** 一圈 = 两道题：我出的一道（01→03）加他出的一道（04→05）⇒ 双方各自 +1 与 +2，每圈都 +3。
    加分时刻与上面每条代码引用一一对应，不是我随手取的增长率 */
export const PK_SCORE = {
  mine: (lap: number, f: number) => 8 + lap * 3 + (f >= 1 ? 1 : 0) + (f >= 4 ? 2 : 0),
  his: (lap: number, f: number) => 6 + lap * 3 + (f >= 2 ? 2 : 0) + (f >= 3 ? 1 : 0),
};

/** 开局比分/答对数取真实对局会有的量级（不参与任何计算）；道具每局 `HELP_PER_MATCH = 1` 个，这一圈没人用掉 */
export const PK_STAT = {
  mine: (f: number) => `答对 ${2 + (f >= 4 ? 1 : 0)}/${3 + (f >= 4 ? 1 : 0)}`,
  his: (f: number) => `答对 ${1 + (f >= 2 ? 1 : 0)}/${2 + (f >= 2 ? 1 : 0)}`,
};

/** 一块屏：产品的页面容器 `sb-pk` 原样用（一个 `.sb-pk` = 一块屏），外面只加一圈机身 */
export function Screen({ side, score, stat, children }: { side: string; score: number; stat: string; children: ReactNode }) {
  return (
    <div className="landing-pk-screen">
      <div className="landing-pk-screen-head">
        <span className="landing-pk-side">{side}</span>
        <span className="landing-pk-meta">
          <span className="sb-pk-arena-score">{score}</span>
          <span className="sb-pk-sub">{stat} · 求助 {HELP_PER_MATCH}</span>
        </span>
      </div>
      <div className="sb-pk landing-pk-screen-body">{children}</div>
    </div>
  );
}
