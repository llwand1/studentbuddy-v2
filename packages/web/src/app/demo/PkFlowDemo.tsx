/**
 * PkFlowDemo — 对战功能的**过程式演示**（落地页演示窗第 3 个 Tab）。
 *
 * ★ 与 `TermFlowDemo` 的差别只在形态：词条演示靠 opacity/class 换场（同一批元素常驻，
 *   逐帧点亮），对战演示的五个屏态在产品里**本来就是互斥的**（`PkMatch.tsx` 按
 *   `quizPending / question / verdict / result` 分别条件渲染，同一时刻页面上只有一块）。
 *   所以这里用条件渲染而不是 CSS 显隐白名单——**帧渲染什么，就等于产品渲染什么**，
 *   jsdom 里也才能直接断「第 N 帧有没有这一块」。
 *
 * ★★ 动效来源纪律（老板 2026-09-21：「实际效果和演示效果差别不要太大，别货不对板」）：
 *   产品 `pk.css` 一共只有 6 条 keyframes（sb-pop / sb-shake / sb-breathe / sb-sheen /
 *   sb-rise / sb-num，pk.css:1024-1101），挂在三处——出题中呼吸+骨架屏（:695-735）、
 *   判定闪屏（:744-800）、结算逐条登场+终分跳入（:803-889）。本演示用其中 **5** 条
 *   （答错那一支 `sb-shake` 演示不演 ⇒ 不搬，理由写在 `demo.css:471`），
 *   时长/缓动/延迟全部照抄产品原值（连 `cubic-bezier(0.2, 0.9, 0.3, 1.4)` 都没圆整）。
 *   09-16 那份《PK对战过渡动效探索稿》里的全屏 3-2-1 遮罩、内发光、白闪、VS 弹入、
 *   +2 飘字、选项 72ms 错峰、45s 走条、结果高光扫，产品里**一行对应代码都没有** ⇒ 不进产品。
 *   每一帧对应哪个真实组件的哪个状态，写在 registry.ts 的 caption 里。
 * ★★ 屏态里的**每一个值**都必须在产品里可能出现，包括 HUD 上那行小字：本组件原先写死
 *   「我 · 求助 2」，而契约是每局只有 `HELP_PER_MATCH = 1` 个道具（`shared/src/pk.ts:123`）
 *   ⇒ 那是个**实物里根本不可能出现**的读数，正是「货不对板」最容易被忽略的一类
 *   （2026-09-21 自查发现，`demo/PkFlowDemo.test.tsx` 已补不变量锁）。求助数现在直接引常量。
 * ★ 2026-09-22 中英切换批：屏态文字转 `Bi`（下面的 `SCREEN` 表）。双语只换**读数措辞**，
 *   不换读数本身——比分、时限、求助数仍与中文版逐格相同（`PkFlowDemo.test.tsx` 锁着）。
 */
import { HELP_PER_MATCH } from '@sb/shared';
import { useLandingLang, type Bi, type LandingLang } from '../landing-lang';
import { PK_DEADLINE, PK_PENDING, PK_QUESTION, PK_SECONDS, useFrameCount } from './pk-flow';

const SCREEN: {
  rival: Bi;
  me: Bi;
  answered: Record<LandingLang, (score: string) => string>;
  topicLabel: Bi;
  topic: Bi;
  topicOwner: Bi;
  myAsk: Bi;
  pending: Bi;
  soon: Bi;
  pendingHint: Bi;
  yourTurn: Bi;
  correct: Bi;
  verdictGone: Bi;
  win: Bi;
  wonLine: Bi;
  reason: Bi;
} = {
  rival: { zh: '对手', en: 'Rival' },
  me: { zh: '我', en: 'Me' },
  answered: {
    zh: (score) => `答对 ${score} · 求助 ${HELP_PER_MATCH}`,
    en: (score) => `${score} correct · ${HELP_PER_MATCH} help`,
  },
  topicLabel: { zh: '本轮主题', en: 'Round topic' },
  topic: { zh: '圆周运动', en: 'Circular motion' },
  topicOwner: { zh: '对手的主题', en: 'Rival’s topic' },
  myAsk: {
    zh: '我发出的出题请求：用「受力分析」出道单选题，别太简单',
    en: 'My authoring request: make a single-choice question on force analysis — not too easy',
  },
  pending: { zh: '对手正在出题', en: 'Rival is authoring a question' },
  soon: { zh: '马上就好', en: 'Any second now' },
  pendingHint: { zh: '题目一出来就自动出现在这里，不用刷新', en: 'The question shows up here the moment it lands — no refresh' },
  yourTurn: { zh: '轮到你答', en: 'Your turn' },
  correct: { zh: '答对 +2', en: '+2 correct' },
  verdictGone: { zh: '2.5s 后自动消失', en: 'clears in 2.5s' },
  win: { zh: '胜', en: 'Win' },
  wonLine: { zh: '这局你赢了', en: 'You won this round' },
  reason: { zh: '对手投降 · 终局判定', en: 'Rival surrendered · final call' },
};

/** 三栏（左对手｜中动作｜右我，`PkArena.tsx:53-61`）压成横条：302px 高放不下真布局 */
function Hud({ stage }: { stage: number }) {
  const { lang } = useLandingLang();
  // 比分在产品里是 SSE 回灌后**无动画**地换文本（`pk-view.ts:74-117` 里没有过渡）⇒ 这里也只换数字
  const mine = stage >= 3 ? 5 : 3;
  return (
    <div className={stage === 0 ? 'ld-pk-hud ld-pk-in' : 'ld-pk-hud'}>
      <div className="ld-pk-pl">
        <span className="ld-pk-nm">
          {SCREEN.rival[lang]}
          <span className="ld-pk-ai">AI</span>
        </span>
        <span className="ld-pk-sc">1</span>
        <span className="ld-pk-sub">{SCREEN.answered[lang]('1/3')}</span>
      </div>
      <div className="ld-pk-topic">
        <span className="ld-pk-tl">{SCREEN.topicLabel[lang]}</span>
        <span className="ld-pk-tn">{SCREEN.topic[lang]}</span>
        <span className="ld-pk-to">{SCREEN.topicOwner[lang]}</span>
      </div>
      <div className="ld-pk-pl ld-pk-me">
        <span className="ld-pk-nm">{SCREEN.me[lang]}</span>
        <span className="ld-pk-sc">{mine}</span>
        <span className="ld-pk-sub">{SCREEN.answered[lang]('2/3')}</span>
      </div>
    </div>
  );
}

/** s2 出题中：三点呼吸 + 三行骨架扫光 + 真「已过 Ns」（逐条对 `PkQuizPending.tsx:21-36`） */
function Pending() {
  const { lang } = useLandingLang();
  const sec = useFrameCount(true, PK_PENDING.from, PK_PENDING.to, PK_PENDING.everyMs);
  return (
    <div className="ld-pk-pending">
      <div className="ld-pk-p-head">
        <span className="ld-pk-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="ld-pk-p-text">{SCREEN.pending[lang]}</span>
        <span className="ld-pk-p-sec">{sec > 0 ? PK_SECONDS[lang](sec) : SCREEN.soon[lang]}</span>
      </div>
      <div className="ld-pk-sk" aria-hidden="true">
        <span className="ld-pk-sk-line w70" />
        <span className="ld-pk-sk-line w92" />
        <span className="ld-pk-sk-line w55" />
      </div>
      <p className="ld-pk-hint">{SCREEN.pendingHint[lang]}</p>
    </div>
  );
}

/** s3 轮到你答：卡头 + 45s 真递减 + ≤10s 变粗（`PkAnswerBlock.tsx:28-56`） */
function Question() {
  const { lang } = useLandingLang();
  const left = useFrameCount(true, PK_DEADLINE.from, PK_DEADLINE.to, PK_DEADLINE.everyMs);
  return (
    <div className="ld-pk-q">
      <div className="ld-pk-q-head">
        <span className="ld-pk-q-h">{SCREEN.yourTurn[lang]}</span>
        <span className={left <= 10 ? 'ld-pk-deadline urgent' : 'ld-pk-deadline'}>{left}s</span>
      </div>
      <p className="ld-pk-stem">{PK_QUESTION.stem[lang]}</p>
      {/* 产品这里是 4 个真 `<button>`（点下去要发答案）。演示窗没有后端，画成按钮会造出
          四个点了没反应的死控件 ⇒ 用 span 承同一套样式，只保留「选中态」的视觉 */}
      <div className="ld-pk-options">
        {PK_QUESTION.options[lang].map((opt, i) => (
          <span className={i === PK_QUESTION.picked ? 'ld-pk-o picked' : 'ld-pk-o'} key={i}>
            <span className="ld-pk-lt">{'ABCD'[i]}</span>
            {opt}
          </span>
        ))}
      </div>
    </div>
  );
}

/** s4 判定：产品只闪**我自己**的一条横幅，2.5s 到点自动清空（`PkMatch.tsx:53` VERDICT_MS） */
function Verdict() {
  const { lang } = useLandingLang();
  return (
    <div className="ld-pk-verdict correct">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="ld-pk-v-ring" cx="12" cy="12" r="9.5" />
        <path className="ld-pk-v-mark" d="M4.5 12.5 L9.5 17.5 L19.5 6.5" />
      </svg>
      <span className="ld-pk-v-text">{SCREEN.correct[lang]}</span>
      <span className="ld-pk-v-gone">{SCREEN.verdictGone[lang]}</span>
    </div>
  );
}

/** s5 结算：面板 rise → 徽章 pop → 标题/原因/比分逐条 rise → 终分跳入（`PkResult.tsx:35-62`） */
function Result() {
  const { lang } = useLandingLang();
  return (
    <div className="ld-pk-result">
      <div className="ld-pk-r-badge">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 4h10v5a5 5 0 0 1-10 0z" />
          <path d="M12 14v3M8.5 20h7" />
        </svg>
        <span>{SCREEN.win[lang]}</span>
      </div>
      <div className="ld-pk-r-t">{SCREEN.wonLine[lang]}</div>
      <div className="ld-pk-r-reason">{SCREEN.reason[lang]}</div>
      <div className="ld-pk-r-score">
        <div className="ld-pk-r-side">
          <span className="ld-pk-nm">{SCREEN.rival[lang]}</span>
          <span className="ld-pk-num">1</span>
          <span className="ld-pk-sub">{SCREEN.answered[lang]('1/3')}</span>
        </div>
        <div className="ld-pk-r-side won">
          <span className="ld-pk-nm">{SCREEN.me[lang]}</span>
          <span className="ld-pk-num">5</span>
          <span className="ld-pk-sub">{SCREEN.answered[lang]('2/3')}</span>
        </div>
      </div>
    </div>
  );
}

export function PkFlowDemo({ stage }: { stage: number }) {
  const { lang } = useLandingLang();
  return (
    <div className="ld-pk">
      <Hud stage={stage} />
      <div className="ld-pk-body">
        {(stage === 0 || stage === 1) && (
          <div className="ld-pk-bubble">
            <span>{SCREEN.myAsk[lang]}</span>
          </div>
        )}
        {stage === 1 && <Pending />}
        {stage === 2 && <Question />}
        {stage === 3 && <Verdict />}
        {stage === 4 && <Result />}
      </div>
    </div>
  );
}
