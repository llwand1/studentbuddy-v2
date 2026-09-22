/**
 * pk-copy — `PkJourney` 那一节（两块屏 × 五帧）的**全部上屏文案**（2026-09-22 中英切换批）。
 *
 * ★ 为什么从 `pk-boards.tsx` 拆出来：那块屏本来 297/300 行，双语化要把每条文案变成
 *   `{zh,en}` 成对，硬留在组件里必然撞 gates 的行数墙。拆开后组件只剩结构与产品代码引用，
 *   文案集中在这里——与 `landing-copy.ts` / `landing-data.ts` 同一条「组件里不留中文字面量」的纪律。
 *
 * ★ 内容口径不变：每一块屏态对应产品哪一行代码，仍然逐条写在 `pk-boards.tsx` 的头注里。
 *   英文侧是**同一件产品事实**的等价说法，没有新增产品里不存在的屏态（那正是
 *   `PkJourney.test.tsx` 那张屏态矩阵要反驳的东西）。
 *
 * ★ 示例题（`Q_MINE`/`Q_HIS`）是前端写死的演示数据：英文侧沿用同一道圆周运动题的直译，
 *   选项数与正确项下标都不换 ⇒ 判词里那个「正确答案 B / C」两语指的是同一个选项。
 */
import type { Bi, LandingLang } from './landing-lang';

/** 本轮主题（真局里由服务端按池轮转，这里取两个物理主题） */
export const TOPICS = {
  mine: { zh: '圆周运动', en: 'Circular motion' },
  his: { zh: '万有引力', en: 'Universal gravitation' },
} as const satisfies Record<string, Bi>;

/* 出题框里那行字是**各人自己敲的**，所以四格按「谁 + 当前主题」命名：同一秒钟两块屏上的
   出题框可以同主题（主题是全房间共享的），但**不会是同一段话**——写成同一段就是复制粘贴了 */
export const PROMPTS = {
  meOrbit: { zh: '用「向心力的来源」出道单选题，别太简单', en: 'Set a multiple-choice question on where centripetal force comes from — not an easy one' },
  meGrav: { zh: '出一道关于双星系统的单选题', en: 'Set a multiple-choice question about binary star systems' },
  himGrav: { zh: '出一个月球表面重力加速度的单选题', en: 'Set a multiple-choice question on gravitational acceleration at the Moon’s surface' },
  himOrbit: { zh: '用「圆锥摆」出道单选题', en: 'Set a multiple-choice question about a conical pendulum' },
} as const satisfies Record<string, Bi>;

export type DemoQuestion = { stem: Bi; options: Record<LandingLang, string[]> };

/** 我出的那道（他答）。正确答案是第 2 个选项 ⇒ 判词写「正确答案 B」 */
export const Q_MINE: DemoQuestion = {
  stem: {
    zh: '一个物块随圆盘一起做匀速圆周运动，使它获得向心力的是？',
    en: 'A block rides a spinning turntable in uniform circular motion. What provides the centripetal force?',
  },
  options: {
    zh: ['重力沿盘面的分量', '盘面对它的静摩擦力', '沿切面的「冲力」', '支持力'],
    en: ['The in-plane component of gravity', 'Static friction from the disk', 'A tangential "impulse"', 'The normal force'],
  },
};
/** 他出的那道（我答）。正确答案是第 3 个选项 ⇒「正确答案 C」 */
export const Q_HIS: DemoQuestion = {
  stem: {
    zh: '两颗星只在彼此的万有引力下绕共同质心做匀速圆周运动，一定相同的是？',
    en: 'Two stars orbit their common centre of mass under their mutual gravitation alone. What must be identical?',
  },
  options: {
    zh: ['轨道半径', '线速度', '周期', '质量'],
    en: ['Orbital radius', 'Linear speed', 'Orbital period', 'Mass'],
  },
};

/** 选项序号（两语同一套 A/B/C/D，与选项数组下标一一对应） */
const LETTERS = 'ABCD';

/** 折叠区「已判定」那一行的判词（`PkMatch.tsx:271` 的公开快照字段形态） */
const JUDGED_LINE: Bi = { zh: '答对 +2 · 正确答案 {L}', en: 'Correct +2 · answer {L}' };

export function judgedLine(correctIndex: number, lang: LandingLang): string {
  return JUDGED_LINE[lang].replace('{L}', LETTERS[correctIndex] ?? '?');
}

/** 屏上那些小标签。★ `rivalTopic` 中文侧那个空格是产品模板自带的（昵称就是「对手」，见 `pk-view.ts:105-109`） */
export const T = {
  roundTopic: { zh: '本轮主题', en: 'This round’s topic' },
  yourTopic: { zh: '你的主题', en: 'Your topic' },
  rivalTopic: { zh: '对手 的主题', en: 'Rival’s topic' },
  setForRival: { zh: '出题给对手', en: 'Set a question for your rival' },
  quizHint: {
    zh: '题目必须贴合本轮主题「{t}」，跑题会被裁判判失败；成功 +1（60s 冷却）',
    en: 'It must fit this round’s topic “{t}”. Off-topic counts as a failure; +1 on success (60s cooldown)',
  },
  single: { zh: '单选', en: 'Choice' },
  trueFalse: { zh: '判断', en: 'True / false' },
  aiQuizing: { zh: 'AI 出题中…', en: 'AI is writing it…' },
  cooldown: { zh: '冷却中', en: 'Cooling down' },
  send: { zh: '出题', en: 'Set it' },
  yourTurn: { zh: '轮到你答', en: 'Your turn' },
  waitingRival: { zh: '等待对手作答…', en: 'Waiting for your rival…' },
  collapse: { zh: '收起', en: 'Collapse' },
  judged: { zh: '已判定', en: 'Judged' },
  rivalSetting: { zh: '对手正在出题', en: 'Your rival is setting a question' },
  mineSide: { zh: '我这一侧', en: 'My screen' },
  rivalSide: { zh: '对手那一侧', en: 'Their screen' },
  verdictCorrect: { zh: '答对 +2', en: 'Correct +2' },
  answered: { zh: '答对 {n}/{m}', en: '{n}/{m} correct' },
  helps: { zh: '求助 {n}', en: '{n} help' },
} as const satisfies Record<string, Bi>;

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => String(values[key] ?? all));
}

export const quizHint = (topic: string, lang: LandingLang) => fill(T.quizHint[lang], { t: topic });
export const answered = (n: number, m: number, lang: LandingLang) => fill(T.answered[lang], { n, m });
export const helps = (n: number, lang: LandingLang) => fill(T.helps[lang], { n });

/**
 * 「对手正在出题」那张卡的两条内部读数（产品组件 `PkQuizPending.tsx:29,36` 写死中文）。
 * 本批给该组件加了**可选** props（缺省即产品原来那两句），所以这里只负责把双语值递进去。
 * ★ `sec > 0` 这一判据与产品那一行同规则——两处都改才不会漂，改产品那行时记得同步这里。
 */
const PENDING_SEC: Bi = { zh: '已过 {s}s', en: '{s}s elapsed' };
const PENDING_SOON: Bi = { zh: '马上就好', en: 'Any moment now' };
const PENDING_HINT: Bi = {
  zh: '题目一出来就自动出现在这里，不用刷新',
  en: 'The question appears here on its own — no need to refresh',
};

export const pendingSec = (sec: number, lang: LandingLang) =>
  sec > 0 ? fill(PENDING_SEC[lang], { s: sec }) : PENDING_SOON[lang];
export const pendingHint = (lang: LandingLang) => PENDING_HINT[lang];

/** 一节之外还有一句诚实标注：它在两种语言里都不许被当成文案修饰删掉 */
export const SECTION = {
  aria: { zh: '对战：一道题在两块屏上同时走完', en: 'Duel: one question, finished on two screens at once' },
  h2Pre: { zh: '对战时你看到的，', en: 'In a duel you see ' },
  h2Accent: { zh: '只是两块屏中的一块', en: 'only one of two screens' },
  sub: {
    zh: '下面左右是同一局里同时开着的两块屏。同一秒钟，一块上写着「等待对手作答」，另一块上写着「轮到你答」——它们必须对得上，因为两边读的是服务端同一份快照',
    en: 'Below, left and right, are two screens open in the same match at the same moment. In the same second one reads “Waiting for your rival…” and the other “Your turn” — they have to agree, because both are reading one server-side snapshot',
  },
  note: {
    zh: '两块屏都是产品的真实屏态：样式就是对战页那份 CSS，「对手正在出题」和「答对 +2」两块用的就是产品组件本身，所以这里动的东西（呼吸点、骨架扫光、判定弹入）在真机上一模一样。压缩掉的只有时间——真一局 8 分钟、出题冷却 60 秒、答题 45 秒，这里 12.5 秒转一圈，冷却因此只画「冷却中」这个状态、不画剩余秒数。另外两处如实交代：折叠区在真机上默认收起，这里为了让人看见「正确答案」那一行画成了展开态；第 04 帧跳过了我那 40 多秒的思考，它按同一条规则在跑。演示取双人对局，单人进门时对手是 AI，走同一条出题与答题路径。',
    en: 'Both screens are real product states: the styling is the duel page’s own CSS, and the “rival is setting a question” and “Correct +2” blocks are the product components themselves — so everything that moves here (breathing dots, skeleton sweep, verdict pop) moves exactly the same on a real device. Only time is compressed: a real match is 8 minutes, cooldown 60s, answering 45s, and a lap here takes 12.5 seconds, which is why the cooldown is drawn as a state and not as remaining seconds. Two more things stated plainly: the folded section is collapsed by default on a real device and is shown expanded so you can see the “correct answer” line; frame 04 skips my own 40-odd seconds of thinking, which runs under the same rule. The demo shows a two-human match — solo matches pair you with an AI opponent that follows the same set-and-answer path.',
  },
} as const satisfies Record<string, Bi>;

/** 五帧的说明文字（右侧清单，与两块屏同一个 `f` 派生 ⇒ 不可能对不上） */
export const FRAME_COPY: Array<{ no: string; title: Bi; lead: Bi; desc: Bi }> = [
  {
    no: '01',
    title: { zh: '我按下「出题」', en: 'I press "Set it"' },
    lead: { zh: '生成的那几秒，他那块屏不是空白', en: 'Those few seconds of generation are not blank on his screen' },
    desc: {
      zh: '出题要现场调模型生成，耗时数秒。服务端在落冷却的同时把「谁在出题」写进房间状态广播出去，对手立刻看到呼吸的三点、三行骨架和「已过 Ns」。不画假进度条——真的不知道还要几秒，画一根会走完的进度条等于撒谎。',
      en: 'Setting a question calls the model live and takes seconds. The server writes “who is setting” into the room state in the same beat it starts the cooldown, so the rival immediately sees breathing dots, three skeleton lines and “Ns elapsed”. No fake progress bar — nobody actually knows how many seconds are left, and a bar that always finishes would be a lie.',
    },
  },
  {
    no: '02',
    title: { zh: '题落到他屏上', en: 'The question lands on his screen' },
    lead: { zh: '同一个 45 秒，两副样子', en: 'The same 45 seconds, two different shapes' },
    desc: {
      zh: '他那边是「轮到你答」加四个选项；我这边这题只以一行「等待对手作答」出现，出题框已经在给下一题起草。两边显示的是同一个数——时限是服务端下发的时间戳，两块屏各自本地起表才会真的对不上。成功出题的 +1 在这同一瞬间到账，本轮主题也在这同一瞬间切给了他。',
      en: 'On his side it is “Your turn” plus four options; on mine the same question is only a line reading “Waiting for your rival…”, and my question box is already drafting the next one. Both show the same number — the deadline is a server-issued timestamp, and it is two locally started clocks that would really disagree. The +1 for a successful question lands in this same instant, and the round topic switches to his in it too.',
    },
  },
  {
    no: '03',
    title: { zh: '他交卷', en: 'He submits' },
    lead: { zh: '判分那一刻，两侧看到的不一样', en: 'At the moment of grading the two sides see different things' },
    desc: {
      zh: '他那侧的「答对 +2」是这次请求的回包，只给他看、2.5 秒自动消失；我这侧只多出一行「已判定」和对手涨上去的分。正确答案要等题目判定完才随快照下发——判定之前它压根不在任何一方收到的数据里，所以答题时抄不到。',
      en: 'His “Correct +2” is the response to that one request, visible only to him and gone after 2.5 seconds; on my side a “Judged” line appears and his score goes up. The correct answer is only pushed with the snapshot once grading finishes — before that it is in neither side’s payload, so there is nothing to copy while answering.',
    },
  },
  {
    no: '04',
    title: { zh: '角色互换', en: 'The roles swap' },
    lead: { zh: '这次 45 秒落在我这侧', en: 'This time those 45 seconds are on my screen' },
    desc: {
      zh: '他按他的主题出好题，倒计时就落到我的屏上；等待的那块位置换成了他的，他的出题框已经进冷却。两侧各有一条互不相干的 60 秒冷却，所以谁也不必等谁——同一局里两个人可以随时同时出题、同时答题。主题此刻已经切回我这侧：它是出题成功那一刻换的，不是等谁答完才换。',
      en: 'He sets a question on his topic and the countdown lands on my screen; the waiting block is now his, and his question box is already cooling down. Each side has its own unrelated 60-second cooldown, so neither waits for the other — at any moment both players can be setting or answering at once. The topic has already flipped back to mine: it changes the instant a question succeeds, not when someone finishes answering.',
    },
  },
  {
    no: '05',
    title: { zh: '一圈合上', en: 'The lap closes' },
    lead: { zh: '两边的 +1 与 +2 都落到账上', en: 'Both sides’ +1 and +2 have landed' },
    desc: {
      zh: '我答对他出的那道，他那侧的「已判定」同样多出一行；一圈转完，双方各自拿到出题的 +1 与答对的 +2，两条比分同步往上走。一局 8 分钟就是这么一圈圈转出来的——转到时钟归零，才弹那一张结算面板。',
      en: 'I get his question right and a line appears in his “Judged” fold too; one lap around and each player has banked a +1 for setting and a +2 for answering, with both scores climbing in step. An 8-minute match is just these laps turning — the result panel only appears when the clock hits zero.',
    },
  },
];

/** 判词用的下标：`Q_MINE` 正确项是第 2 个（B），`Q_HIS` 是第 3 个（C）——与上面两条注释同一口径 */
export const Q_MINE_ANSWER = 1;
export const Q_HIS_ANSWER = 2;
