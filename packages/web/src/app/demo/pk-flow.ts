/**
 * pk-flow — 对战演示的帧内数据 + 那两个「只有真机才会跳的数」。
 *
 * ★ 与 `graph-demo.ts` 同构：内容全部前端写死（老板 2026-09-20 拍板：落地页不连后端，
 *   未登录访客不该看到一个可能报错的演示）。题干/选项取真实屏态里会出现的字段形态。
 *
 * ★ 关于「帧渲染器不持有自己的计时器」（registry.ts 里那句）：它约束的是**帧推进**——
 *   推进必须只归 `useDemoPlayer`，否则切 Tab / 重播会同时跑两条时间线。本文件的 hook
 *   不推进帧，只在帧内把产品本来就在跳的数字跳出来，与 `TermFlowDemo` 的打字机
 *   （`useTyping`，同为一个 hook）是同一例外口径。调用方是**只在属于它的那一帧才挂载**
 *   的子组件（`PkFlowDemo` 条件渲染），所以传进来的 `active` 恒真、卸载即停表——
 *   留这个参数是为了让「跳到哪一帧」与「表在不在走」由同一个条件决定，不另起判据。
 */
import { useEffect, useState } from 'react';

/**
 * 帧内计数：`active` 为真的那一帧从 `from` 逐格走向 `to` 并停住（到点即 clearInterval，
 * 留个空转的 interval 是脏的）。`active` 转假时立刻回到 `from`——切走再切回来必须
 * 从第一格重放，否则会看到「已过 8s」停在「对手正在出题」刚出现的那一瞬。
 */
export function useFrameCount(active: boolean, from: number, to: number, everyMs: number): number {
  const [n, setN] = useState(from);
  useEffect(() => {
    setN(from);
    if (!active) return;
    const step = to >= from ? 1 : -1;
    let v = from;
    const iv = window.setInterval(() => {
      v += step;
      setN(v);
      if (v === to) window.clearInterval(iv);
    }, everyMs);
    return () => window.clearInterval(iv);
  }, [active, from, to, everyMs]);
  return n;
}

/** s3「轮到你答」的题面（`PkAnswerBlock.tsx:38-41` 的单选题形态：题干 + 4 选项） */
export const PK_QUESTION = {
  stem: '一个物块随圆盘一起做匀速圆周运动，使它获得向心力的是？',
  options: ['重力沿盘面的分量', '盘面对它的静摩擦力', '沿切面的「冲力」', '支持力'],
  /** 演示演的是**答对**那一支（走 sb-pop .32s；答错走 sb-shake，两支点不着） */
  picked: 1,
};

/** 答题时限：产品口径 45s 真递减，≤10s 加 `.urgent` 变粗（`PkAnswerBlock.tsx:34`） */
export const PK_DEADLINE = { from: 45, to: 0, everyMs: 90 };

/**
 * 出题等待：`PkQuizPending` 的「已过 Ns」是**服务端下发的真数字**，产品注释写死
 * 「不做假进度条，真的不知道还要几秒」。这里按 380ms/格走到 8s 停住——演示窗只给
 * 这一帧 3.2s，所以它一定在帧被切走前自己停下，不会跳到产品没演示过的夸张秒数。
 */
export const PK_PENDING = { from: 0, to: 8, everyMs: 380 };
