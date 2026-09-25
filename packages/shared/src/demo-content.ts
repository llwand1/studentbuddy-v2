/**
 * shared/demo-content — 公用体验账号（`u-demo-shared`）的种子内容（渠道台账 C5）。
 *
 * ★ 为什么放 shared：这批名字**必须与对外讲解页同源**（`packages/web/src/seo/term-corpus.ts`
 *   的 `title`）——访客从「主动回忆是什么、怎么练」那页点进来，词条库里就该看见同一个概念。
 *   常量放 server 侧，web 的语料就锁不到它；放 shared ⇒ `term-corpus.test.ts` 能直接断言
 *   「每个种子词条名都在公开语料里」，漂一个字即刻红（同 `ebbinghaus.ts` 当年为「前后端同一答案」
 *   进 shared 的理由，不是顺手一放）。
 *
 * ★ 三条口径：
 *   ① **只放数据、不碰 IO**——写库由 server 侧 `auth/demo-seed.ts` 用**真实领域函数**完成
 *     （`saveOneTerm` ＋ `markReviewed`），这里不出现任何 SQL；
 *   ② **定义写的是「一个人自己存的笔记」的语气**，不是讲解页那种对外文案：同一个概念在
 *     两处都出现时，产品里那份读起来该像人写的；
 *   ③ ⚠️ **这批内容不是用户产出的**——诚实计数（C4）一律记在 **HTTP 入口侧**，种子走的是
 *     领域函数、不发事件，所以结构上就进不了 C4 的账（不是靠「记得排除」）。
 */
import { MAX_REVIEW_STAGE, reviewIntervalDays } from './ebbinghaus.js';

export interface DemoSeedTerm {
  /** 与公开讲解页的 `title` 逐字相同（web 侧有锁） */
  term: string;
  /** 存进 `term_library.definition` 的那句笔记 */
  definition: string;
  /** 领域名，走 `saveOneTerm` 时顺带登记进 `term_domain`（v19 不变式：词条域 ⊆ 领域登记册） */
  domain: string;
  /**
   * 灌完后停在哪一阶段（`ebbinghaus.ts` 的 stage，0 = 从没复习过、刚入库）。
   * ★ 用它而不是直接写日期：阶段决定间隔，间隔由 `REVIEW_INTERVALS_DAYS` 单一定义，
   *   本文件不重抄一遍数字。
   */
  stage: number;
  /** true ⇒ 把「上次复习」推到按本阶段间隔该复习的那一天，使它**今天就在队列里** */
  dueToday: boolean;
}

/**
 * 八条：四个领域各有人，四条今天到期（首屏因此有活可干），四条在往后（队列不是一眼望到底）。
 * 名字取自公开语料的 `title`；`domain` 是本产品里的领域 Tab，与讲解页无关。
 */
export const DEMO_SEED_TERMS: readonly DemoSeedTerm[] = [
  {
    term: '主动回忆',
    definition: '先合上书自己把答案捞出来，再翻开对。再看一遍不算，得先出答案。',
    domain: '记忆机制',
    stage: 3,
    dueToday: true,
  },
  {
    term: '间隔重复',
    definition: '把复习拆开排在快忘掉的点上，而不是考前一晚全塞回来。',
    domain: '复习策略',
    stage: 2,
    dueToday: true,
  },
  {
    term: '艾宾浩斯遗忘曲线',
    definition: '记住的量随时间往下掉，掉得最快的是刚学完那阵。复习是把它抬回去。',
    domain: '记忆机制',
    stage: 1,
    dueToday: false,
  },
  {
    term: '必要难度',
    definition: '练的时候越顺手，留下的越少。有点吃力的那种练法才算数。',
    domain: '学习方法',
    stage: 0,
    dueToday: false,
  },
  {
    term: '精细加工',
    definition: '给新知识找个「为什么」接到旧东西上，别只记一个孤零零的结论。',
    domain: '记忆机制',
    stage: 4,
    dueToday: true,
  },
  {
    term: '组块',
    definition: '把零散的几样打包成一个整体，工作记忆就腾出位置来了。',
    domain: '记忆机制',
    stage: 2,
    dueToday: false,
  },
  {
    term: '元认知',
    definition: '知道自己哪块是真懂、哪块只是想当然。自测就是量它的尺子。',
    domain: '学习方法',
    stage: 1,
    dueToday: false,
  },
  {
    term: '费曼学习法',
    definition: '讲到外行能听懂为止，卡壳的那句就是自己没懂的那处。',
    domain: '学习方法',
    stage: 1,
    dueToday: true,
  },
];

/**
 * 灌种子时「上次复习」该往回推几天——**天数全部由间隔表算出来**，本文件不写常数。
 *
 * 未到期那几条返回 0（＝今天刚复习过），于是 `computeReviewState` 判成 `upcoming`；
 * 到期那条返回 `reviewIntervalDays(stage)`，恰好落在「间隔走完、保持率 70%」那一天。
 * ⚠️ stage=0 的条目走不到这里（没复习记录，起算点是入库时间），见 `demo-seed.ts`。
 */
export function demoSeedBackdateDays(t: DemoSeedTerm): number {
  return t.dueToday ? reviewIntervalDays(t.stage) : 0;
}

/** 领域 Tab 的显示顺序由种子表内部顺序决定，这里只取去重后的集合给测试与将来复用。 */
export function demoSeedDomains(): string[] {
  return [...new Set(DEMO_SEED_TERMS.map((t) => t.domain))];
}

/** 阶段合法域（`ebbinghaus.ts` 的 MAX），越界会在排期上静默失真，故交给测试守而不是运行时抛。 */
export const DEMO_SEED_MAX_STAGE = MAX_REVIEW_STAGE;
