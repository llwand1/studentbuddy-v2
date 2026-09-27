/**
 * features/continent/useContinentCamera — 视口相机（开放世界批，2026-09-27）。
 *
 * ★ 为什么单独成文件：世界比屏幕大之后，「看得见哪一块」成了一件有状态的事，而 `ContinentMap.tsx`
 *   要守 gates 的「.tsx ≤300 行」红线；相机是**纯计算 + 三个 effect**，与 canvas 指令无关，
 *   拆出来顺带能被单测（`camFor`／`followCam`／`clampCam` 都是纯函数）。
 *
 * ★★ 三条规则（缺一条就出死路）：
 *   ① **相机必须夹在世界里**（`clampCam`）——不夹就能把视野拖到世界外，用户看到一片纯背景；
 *   ② **英雄走出视口 ⇒ 相机跟到"最小可见"**（`followCam`，每次只挪必要的那几格）——
 *      不跟的话英雄会从画面上消失，而键盘还能继续走，"我在哪"就此丢失（ADR-5 禁静默）；
 *   ③ **一键回到英雄**（`recenterTick` 变化 ⇒ `camFor` 居中）——拖远了要能一步回来。
 * ⚠️ **不做**"相机跟随英雄平滑移动"：地图是常驻页，跟着英雄一直动会让远处的格永远看不清
 *   （见 `ContinentMap` 文件头"静止不开 rAF 循环"的同一条取舍：能不动就不动）。
 */
import { useEffect, useRef, useState } from 'react';
import { CONTINENT_VIEW_COLS, CONTINENT_VIEW_ROWS } from '@sb/shared';

/** 视口左上角所在的**世界格**坐标（可为负：世界是以 (0,0) 为中心的有符号坐标） */
export interface ContinentCam {
  row: number;
  col: number;
}

/** 世界里一个位置（英雄脚下那格） */
export interface CamTarget {
  row: number;
  col: number;
}

/** 把相机夹进世界：世界 `[-r, r]²`，视口 `14×10` ⇒ 左上角最大只能到 `r+1-VIEW` */
export function clampCam(cam: ContinentCam, radius: number): ContinentCam {
  const maxRow = radius + 1 - CONTINENT_VIEW_ROWS;
  const maxCol = radius + 1 - CONTINENT_VIEW_COLS;
  // ★ 世界比视口小的退化情形（半径被调到极小）也要能跑：这时中间对齐
  return {
    row: Math.min(Math.max(Math.trunc(cam.row) || 0, -radius), Math.max(maxRow, -radius)),
    col: Math.min(Math.max(Math.trunc(cam.col) || 0, -radius), Math.max(maxCol, -radius)),
  };
}

/** 把某个世界格放在视口正中央（一键回英雄用） */
export function camFor(target: CamTarget | null, radius: number): ContinentCam {
  if (!target) return clampCam({ row: 0, col: 0 }, radius);
  return clampCam(
    {
      row: target.row - Math.floor(CONTINENT_VIEW_ROWS / 2),
      col: target.col - Math.floor(CONTINENT_VIEW_COLS / 2),
    },
    radius,
  );
}

/**
 * 「最小可见」跟随：只在目标**跑出视口**时挪动，且只挪到刚好把它露出来那一格。
 * ★ 这是"英雄走位不跟丢"的唯一实现——不夹取也不居中，免得每走一步整幅地图都跳一下。
 */
export function followCam(cam: ContinentCam, target: CamTarget, radius: number): ContinentCam {
  let { row, col } = cam;
  if (target.row < row) row = target.row;
  else if (target.row > row + CONTINENT_VIEW_ROWS - 1) row = target.row - CONTINENT_VIEW_ROWS + 1;
  if (target.col < col) col = target.col;
  else if (target.col > col + CONTINENT_VIEW_COLS - 1) col = target.col - CONTINENT_VIEW_COLS + 1;
  return clampCam({ row, col }, radius);
}

/**
 * 拖拽平移的**纯计算**：像素位移 → 格位移（按视口比例），**按起点快照整算**（不是累加增量——
 * 累加会把鼠标的抖动攒成漂移），再夹进世界。
 * ★ 返回 `null` ＝"这一下没挪动"（位移不足一格）⇒ 调用方据此判"这是点击还是拖拽"。
 * ★ 放这里而不是组件里：组件要守行数红线，而这段是纯几何、可单测。
 */
export function camAfterDrag(
  drag: { x: number; y: number; cam: ContinentCam },
  clientX: number,
  clientY: number,
  rect: { width: number; height: number },
  radius: number,
): ContinentCam | null {
  if (rect.width === 0 || rect.height === 0) return null;
  const dCol = Math.round(((clientX - drag.x) / rect.width) * CONTINENT_VIEW_COLS);
  const dRow = Math.round(((clientY - drag.y) / rect.height) * CONTINENT_VIEW_ROWS);
  if (dCol === 0 && dRow === 0) return null;
  return clampCam({ row: drag.cam.row - dRow, col: drag.cam.col - dCol }, radius);
}

/**
 * 相机状态。`recenterTick` 每次自增＝"回到我身上"被按了一次（★ 用计数而不是回调：地图是纯渲染层，"让相机做什么"由页面用数据表达，它不需要持有 setState）。
 */
export function useContinentCamera(
  radius: number,
  hero: CamTarget | null,
  recenterTick: number,
): { cam: ContinentCam; setCam: (next: ContinentCam) => void } {
  const [cam, setCam] = useState<ContinentCam>(() => camFor(null, radius));
  const hadHero = useRef(false);

  /**
   * ① 英雄第一次出现（地图刚取完数）⇒ **渲染期就居中**。
   *
   * ★★ 为什么用渲染期纠偏而不是 `useEffect`：首帧（`hero === null`）相机只能落在世界原点，
   *   而英雄通常不在原点——用 effect 纠偏会留下**一帧错位**：这一帧里点地图会点到别处，
   *   测试里表现为"点了怪但弹窗没开"的偶发红（全量并发跑时被压出来过）。
   *   React 官方允许"渲染期按 props 调整 state"（同一组件、带守卫 ⇒ 不会死循环），
   *   这里就是那个模式：`hadHero` 守卫使它每个会话只跑一次。
   */
  if (!hadHero.current && hero) {
    hadHero.current = true;
    setCam(camFor(hero, radius));
  }

  // ② 此后只在英雄**走出视口**时跟（最小可见）；值没变就不写 state，免得每一步都多余重渲染
  useEffect(() => {
    setCam((c) => {
      const next = followCam(c, hero ?? { row: c.row, col: c.col }, radius);
      return next.row === c.row && next.col === c.col ? c : next;
    });
    // ★ 只认这三样：hero 走一步、或世界半径变了（`recenterTick` 单独管）
  }, [hero?.row, hero?.col, radius]);

  // ③ 世界半径变大（加了词条）⇒ 夹一次，避免相机停在已经不存在的边界上
  useEffect(() => {
    setCam((c) => clampCam(c, radius));
  }, [radius]);

  // ④ 「回到我身上」
  useEffect(() => {
    if (hero) setCam(camFor(hero, radius));
    // ★ 只认 token：hero 走一步不该把用户手拖的视野收回去
  }, [recenterTick]);

  return { cam, setCam };
}