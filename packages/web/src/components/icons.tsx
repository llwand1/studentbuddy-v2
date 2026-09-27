/**
 * SVG 像素图标基座 — 24×24 整数网格、方形端点与阶梯轮廓。
 * currentColor 随主题变色；保留既有组件 API 与可访问性属性。
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
    strokeWidth: 2,
    strokeLinecap: 'square' as const,
    strokeLinejoin: 'miter' as const,
    shapeRendering: 'crispEdges',
    ...rest,
  };
}

/** 对话（学环） */
export function ChatIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M4 4h16v12H10v2H8v2H6v-4H4zM8 8h8M8 12h4" />
    </svg>
  );
}

/** 题库（练环） */
export function QuizIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M6 4h12v16h-4v-2h-4v2H6z" />
      <path d="M9 10v2h3v-2h2V8h2" />
    </svg>
  );
}

/** 背词（忆环） */
export function CardsIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <rect x="4" y="8" width="12" height="12" />
      <path d="M8 8V4h12v12h-4M8 12h4M8 16h2" />
    </svg>
  );
}

/** 反馈环（欢迎卡「看看进度」） */
export function StatsIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M4 20h16M5 18v-6h2v6M11 18V4h2v14M17 18v-8h2v8" />
    </svg>
  );
}

/** 文档模式（本会话载入一篇资料） */
export function DocIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M6 4h8v2h2v2h2v12H6z" />
      <path d="M14 4v4h4M10 12h4M10 16h4" />
    </svg>
  );
}

/** 情景题（烧瓶——可交互 demo 的实验感，与 QuizIcon 的卷子形区分开） */
export function FlaskIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M8 4h8M10 4v6H8v4H6v6h12v-6h-2v-4h-2V4M6 16h12" />
    </svg>
  );
}

/** 设置 */
export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M8 4h8v4h4v8h-4v4H8v-4H4V8h4z" />
      <rect x="10" y="10" width="4" height="4" />
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
      <path d="M4 12h2v2h2v2h4v-4h2v-2h2V8h2V6h2" />
    </svg>
  );
}

/** 对战（双人相向）——PK 入口。刻意不画交叉剑：那在 18px 下会糊成一个叉号，像「关闭」 */
export function VsIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M4 4h4v6H4zM16 4h4v6h-4zM2 20v-6h8v6M14 20v-6h8v6" />
    </svg>
  );
}

/** 发送 */
export function SendIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M12 20V4M6 10h2V8h2V6h4v2h2v2h2" />
    </svg>
  );
}

/** 停止生成：实心方块（主流范式），base 的 fill:none 只作用于描边路径 */
export function StopIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <rect x="6" y="6" width="12" height="12" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 联网搜索（工具步骤/搜索设置） */
export function SearchIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M6 4h8v2h2v8h-2v2H6v-2H4V6h2zM16 16h2v2h2v2" />
    </svg>
  );
}

/** 导出（对话 → Markdown 文件） */
export function DownloadIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M12 4v12M6 10h2v2h2v2h4v-2h2v-2h2M4 18v2h16v-2" />
    </svg>
  );
}

/** 置顶（会话列表） */
export function PinIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M8 4h8M10 4v6H8v2H6v2h12v-2h-2v-2h-2V4M12 14v6" />
    </svg>
  );
}

/** 下箭头（侧栏历史对话展开/收起） */
export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M6 8v2h2v2h2v2h4v-2h2v-2h2V8" />
    </svg>
  );
}

/** 时钟（侧栏历史对话标题） */
export function ClockIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M8 2h8v2h4v4h2v8h-2v4h-4v2H8v-2H4v-4H2V8h2V4h4zM12 6v6h4" />
    </svg>
  );
}

/** 用户（侧栏头像） */
export function UserIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M8 4h8v8H8zM4 20v-4h4v-2h8v2h4v4" />
    </svg>
  );
}

/** 学习流（控制流：两个步骤节点 + 一条折线走向） */
export function FlowIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <rect x="4" y="4" width="8" height="6" />
      <rect x="12" y="14" width="8" height="6" />
      <path d="M12 6h4v8M8 10v6h4" />
    </svg>
  );
}

/** 知识图（中心节点 + 三个邻居 + 辐射连线） */
export function GraphIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M10 2h4v4h-4zM8 10h8v4H8zM2 18h4v4H2zM18 18h4v4h-4zM12 6v4M8 14v4H6M16 14v4h2" />
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
