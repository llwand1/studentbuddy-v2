/**
 * SVG line-icon 基座 — 自绘矢量图标（G5：禁 emoji，currentColor 浅/暗自适应）。
 * 约定：24×24 viewBox、1.6 描边、round 端点；新图标加一个组件即可。
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

/** 对话（学环） */
export function ChatIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4 4v-4H6a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** 题库（练环） */
export function QuizIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M5 4h14v16l-7-3-7 3z" />
      <path d="M9.5 9.5 12 12l4.5-4.5" />
    </svg>
  );
}

/** 背词（忆环） */
export function CardsIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <rect x="4" y="7" width="12" height="13" rx="2" />
      <path d="M8 7V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3" />
    </svg>
  );
}

/** 反馈环（欢迎卡「看看进度」）——★ 2026-09-25 原「今日总结」页下线后它只剩这一个用处，图标本身留着 */
export function StatsIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M5 20V10M12 20V4M19 20v-7" />
    </svg>
  );
}

/** 文档模式（本会话载入一篇资料） */
export function DocIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 12h6M9 16h5" />
    </svg>
  );
}

/** 情景题（烧瓶——可交互 demo 的实验感，与 QuizIcon 的卷子形区分开） */
export function FlaskIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M9.5 3h5M10.5 3v5.2L4.8 17.6A2.2 2.2 0 0 0 6.8 21h10.4a2.2 2.2 0 0 0 2-3.4L13.5 8.2V3" />
      <path d="M7.2 15.5h9.6" />
    </svg>
  );
}

/** 设置 */
export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" />
    </svg>
  );
}

/** 新对话 / 输入框「+」展开菜单的触发器 */
export function PlusIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** 缩小（画布缩放条）。★ 与 PlusIcon 同构：一条横线，18px 下不会和「关闭」混 */
export function MinusIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M5 12h14" />
    </svg>
  );
}

/** 适配窗口（四角括号内收 = 「把内容收进画框」）——画布「看全貌」按钮 */
export function FitIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  );
}

/** 勾选（菜单里的开关项「已开」标记） */
export function CheckIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

/** 对战（双人相向）——PK 入口。刻意不画交叉剑：那在 18px 下会糊成一个叉号，像「关闭」 */
export function VsIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <circle cx="7" cy="7" r="2.6" />
      <path d="M2.6 19.4c0-2.4 2-4.4 4.4-4.4s4.4 2 4.4 4.4" />
      <circle cx="17" cy="7" r="2.6" />
      <path d="M12.6 19.4c0-2.4 2-4.4 4.4-4.4s4.4 2 4.4 4.4" />
    </svg>
  );
}

/** 发送 */
export function SendIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

/** 停止生成：实心方块（主流范式），base 的 fill:none 只作用于描边路径 */
export function StopIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 联网搜索（工具步骤/搜索设置） */
export function SearchIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5 20 20" />
    </svg>
  );
}

/** 导出（对话 → Markdown 文件） */
export function DownloadIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M12 4v11M7 10l5 5 5-5M5 19h14" />
    </svg>
  );
}

/** 置顶（会话列表） */
export function PinIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M9 4h6l-1 6 4 3v2h-5v5l-1 1-1-1v-5H6v-2l4-3z" />
    </svg>
  );
}

/** 下箭头（侧栏历史对话展开/收起） */
export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** 时钟（侧栏历史对话标题） */
export function ClockIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** 用户（侧栏头像） */
export function UserIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
    </svg>
  );
}

/** 学习流（控制流：两个步骤节点 + 一条折线走向） */
export function FlowIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <rect x="3" y="4" width="9" height="6" rx="1.5" />
      <rect x="12" y="14" width="9" height="6" rx="1.5" />
      <path d="M12 7h1.5a2 2 0 0 1 2 2v5" />
      <path d="M7.5 10v4a2 2 0 0 0 2 2H12" />
    </svg>
  );
}

/** 知识图（中心节点 + 三个邻居 + 辐射连线） */
export function GraphIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="4" r="2" />
      <circle cx="5" cy="18.5" r="2" />
      <circle cx="19" cy="18.5" r="2" />
      <path d="M12 6.5v2.5" />
      <path d="M9.8 14.2 6.6 16.8" />
      <path d="M14.2 14.2l3.2 2.6" />
    </svg>
  );
}

/** GitHub（octocat 线稿轮廓，登录入口与开源仓库外链共用） */
export function GithubIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
    </svg>
  );
}
