/**
 * pk-frames — `PkJourney` 那一节的**五帧表**：每帧两侧各画哪几块屏（2026-09-22 双语批拆出）。
 *
 * ★ 为什么单独一个文件：本节的四份东西各有自己的改动理由，混在一个文件里就会撞 gates 的
 *   `.tsx ≤300` 行墙（原来 297 行）。拆开后各归各的：
 *   屏态积木与「这一块对应产品哪一行代码」→ `./pk-boards.tsx`；
 *   上屏文案（中英成对）→ `./pk-copy.ts`；
 *   **帧序与两侧的屏态组合**→ 本文件（这里只有结构，一个字的文案都没有）。
 *
 * ★ 帧的 `mine`/`his` 是**在 `PkJourney` 渲染中被调用的普通函数**，不是组件 ⇒ 里面不能调 hook。
 *   语言因此由各屏态积木自己取（见 `pk-boards.tsx` 头注），本文件对 `lang` 完全无感——
 *   这也顺手保证了「两种语言画的是同一套屏态」：想按语言改屏态结构，得先改这张表的类型。
 *
 * ★ 这张表与 `FRAME_COPY` 必须等长：`PK_FRAMES` 由二者 zip 而来，少一格当场抛。
 *   每帧画哪几块的回归锁在 `PkJourney.test.tsx`（五帧 × 两侧的屏态矩阵）。
 */
import type { ReactNode } from 'react';
import type { Bi } from './landing-lang';
import { Answer, Done, Pending, QuizBox, Topic, Verdict, Waiting } from './pk-boards';
import { FRAME_COPY, PROMPTS, Q_HIS, Q_HIS_ANSWER, Q_MINE, Q_MINE_ANSWER, TOPICS } from './pk-copy';

/** 帧内实时值：两侧共享同一个 `left`（同一份快照在两处的读数），`sec` 给「已过 Ns」 */
export type Live = { left: number; sec: number };

/** 一帧 = 两侧同一秒钟各自看到的屏态。★ 本轮主题不在这张表里当字段：它是**公开快照的一部分**、
    两侧同值，但「是谁的主题」按看屏的人算 ⇒ 交给每帧里那两个 `<Topic/>` 各自表态 */
type Board = { mine: (l: Live) => ReactNode; his: (l: Live) => ReactNode };

export type PkFrame = { no: string; title: Bi; lead: Bi; desc: Bi } & Board;

const BOARDS: Board[] = [
  {
    mine: () => (
      <>
        <Topic topic={TOPICS.mine} viewerOwns />
        <QuizBox topic={TOPICS.mine} state="busy" prompt={PROMPTS.meOrbit} />
      </>
    ),
    his: ({ sec }) => (
      <>
        <Topic topic={TOPICS.mine} viewerOwns={false} />
        <Pending sec={sec} />
      </>
    ),
  },
  {
    mine: ({ left }) => (
      <>
        <Topic topic={TOPICS.his} viewerOwns={false} />
        <Waiting q={Q_MINE} left={left} />
        <QuizBox topic={TOPICS.his} state="cooldown" prompt={PROMPTS.meGrav} />
      </>
    ),
    his: ({ left }) => (
      <>
        <Topic topic={TOPICS.his} viewerOwns />
        <Answer q={Q_MINE} left={left} />
      </>
    ),
  },
  {
    mine: () => (
      <>
        <Topic topic={TOPICS.his} viewerOwns={false} />
        <QuizBox topic={TOPICS.his} state="cooldown" prompt={PROMPTS.meGrav} />
        <Done rows={[{ q: Q_MINE, answer: Q_MINE_ANSWER }]} />
      </>
    ),
    his: () => (
      <>
        <Topic topic={TOPICS.his} viewerOwns />
        <Verdict />
        <QuizBox topic={TOPICS.his} state="ready" prompt={PROMPTS.himGrav} />
      </>
    ),
  },
  {
    mine: ({ left }) => (
      <>
        <Topic topic={TOPICS.mine} viewerOwns />
        <Answer q={Q_HIS} left={left} />
      </>
    ),
    his: ({ left }) => (
      <>
        <Topic topic={TOPICS.mine} viewerOwns={false} />
        <Waiting q={Q_HIS} left={left} />
        <QuizBox topic={TOPICS.mine} state="cooldown" prompt={PROMPTS.himOrbit} />
      </>
    ),
  },
  {
    mine: () => (
      <>
        <Topic topic={TOPICS.mine} viewerOwns />
        <Verdict />
        <QuizBox topic={TOPICS.mine} state="cooldown" prompt={PROMPTS.meOrbit} />
      </>
    ),
    his: () => (
      <>
        <Topic topic={TOPICS.mine} viewerOwns={false} />
        <Done
          rows={[
            { q: Q_MINE, answer: Q_MINE_ANSWER },
            { q: Q_HIS, answer: Q_HIS_ANSWER },
          ]}
        />
      </>
    ),
  },
];

export const PK_FRAMES: PkFrame[] = FRAME_COPY.map((copy, i) => {
  const board = BOARDS[i];
  if (!board) throw new Error(`第 ${i} 帧只有说明没有屏态 ⇒ 说明与屏表必须同批改，别只加文字`);
  return { ...copy, ...board };
});
