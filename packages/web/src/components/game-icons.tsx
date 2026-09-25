/**
 * 游戏化图标集 — 手绘 SVG 线稿，画风对齐 `styles/game.css`（多邻国 / Quizlet 那一挂）。
 *
 * ★ **为什么不加进 `icons.tsx`**：那个文件已经 260 行，且它是「学环／练环／忆环／反馈环」
 *   的导航图标，语义是**产品分区**；本文件全是**游戏物件**（宝箱／钥匙／星／火焰／吉祥物）。
 *   混在一起的下场和 `task-list.ts` 的 `TaskItem` 撞名是同一类病：两套语义共用一个命名空间，
 *   改一个要读另一个。
 * ★ **禁 emoji 作图标**（`icons.tsx` 头注 + `terms.css:614`／`:906` 三处同规）⇒ 游戏风最容易
 *   破功的地方就是"宝箱用 🎁 凑一下"。本文件是游戏化所有图标位的唯一来源。
 * 约定与 `icons.tsx` 完全一致：24×24 viewBox、1.6 描边、round 端点、`stroke: currentColor`
 *   ——所以同一套图标在浅底／彩底／强调色下都能靠 `color` 自适应，不需要按皮肤各画一份。
 *
 * 尺寸口径：导航位 18px（默认）；卡墙／开箱面板的装饰位 22–28px，走 `size` 传，
 *   **不要**为大图重画一份路径——线稿在 28px 下发虚是 `stroke-width` 的问题，
 *   需要时按调用点传 `strokeWidth={1.3}`，别在图标里写死。
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base(size: number | undefined, props: IconProps) {
  const { size: _s, ...rest } = props;
  return {
    width: size ?? 18,
    height: size ?? 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...rest,
  };
}

/** 宝箱 —— 每日开箱入口 / T3 仪式面板主体。盖与身共用一条沿口线，锁扣压在沿口上 */
export function ChestIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M5 9.5V7.2A2.2 2.2 0 0 1 7.2 5h9.6A2.2 2.2 0 0 1 19 7.2v2.3" />
      <path d="M3.5 9.5h17v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      <rect x="10.3" y="8" width="3.4" height="5" rx="1.2" />
    </svg>
  );
}

/** 钥匙 —— 开宝箱的额度（`.gm-stat.gm-key`）。齿沿 45° 轴垂直岔出，不在 18px 下糊成一团 */
export function KeyIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <circle cx="8" cy="8" r="4.2" />
      <path d="M11.1 11.1 20 20" />
      <path d="M15.8 15.8 18 13.6M18.4 18.4 20.6 16.2" />
    </svg>
  );
}

/** 星 —— 卡牌星级。点亮位由调用点给 `fill="currentColor"`，形状两份共用 */
export function StarIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="m12 3 2.7 5.5 6 .9-4.35 4.2 1.03 5.95L12 16.7l-5.38 2.85L7.65 13.6 3.3 9.4l6-.9z" />
    </svg>
  );
}

/** 火焰 —— 连续天数（`.gm-stat.gm-flame`）。内焰那条折线是它区别于「水滴」的关键 */
export function FlameIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5" />
    </svg>
  );
}

/** 任务卡 —— 自动派发的学习任务（`study_task`）。刻意用「卡 + 勾」而不是剪贴板：
 *  夹子在 18px 下会遮住卡的上圆角，两条线混成一块黑 */
export function TaskIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <rect x="4.5" y="4.5" width="15" height="15" rx="3" />
      <path d="m8.6 12 2.4 2.4 4.6-4.8" />
      <path d="M8.6 16.8h4" />
    </svg>
  );
}

/** 闪光 —— 全息闪卡 / 升星粒子。一大一小错开，单颗会读成"加号" */
export function SparkleIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M10.6 3c.9 3.9 2.3 5.3 6.2 6.2-3.9.9-5.3 2.3-6.2 6.2-.9-3.9-2.3-5.3-6.2-6.2C8.3 8.3 9.7 6.9 10.6 3z" />
      <path d="M17.6 14.2c.42 1.75 1.03 2.36 2.78 2.78-1.75.42-2.36 1.03-2.78 2.78-.42-1.75-1.03-2.36-2.78-2.78 1.75-.42 2.36-1.03 2.78-2.78z" />
    </svg>
  );
}

/** 小吉祥物「卡灵」—— 引导气泡与空态用。
 *  ★ 刻意**不画猫头鹰**：多邻国是我们的画风参照，不是形象参照，画猫头鹰等于蹭商标。
 *    它长成"一张活过来的词条卡"，正好就是本功能的主角，比借来的动物站得住。 */
export function MascotIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <rect x="3.6" y="6" width="14.4" height="12.6" rx="3.4" />
      <circle cx="8.3" cy="11.4" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="13.4" cy="11.4" r="0.95" fill="currentColor" stroke="none" />
      <path d="M8.5 14.6a3 3 0 0 0 4.7 0" />
      <path d="M7.4 18.6v2M14.2 18.6v2" />
      <path d="M20.4 2.8v3.4M18.7 4.5h3.4" />
    </svg>
  );
}

/** 锁 —— 额度用完的宝箱（T3 面板上"今天开完了"那一格）。开口朝下＝关着 */
export function LockIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.4" />
      <path d="M8.4 10.5V8a3.6 3.6 0 0 1 7.2 0v2.5" />
      <path d="M12 14.2v2.4" />
    </svg>
  );
}
