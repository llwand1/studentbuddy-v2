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

/** 今日总结（反馈环） */
export function StatsIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M5 20V10M12 20V4M19 20v-7" />
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

/** 新对话 */
export function PlusIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <path d="M12 5v14M5 12h14" />
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

/** 联网搜索（工具步骤/搜索设置） */
export function SearchIcon(props: IconProps) {
  return (
    <svg {...base(props.size, props)}>
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5 20 20" />
    </svg>
  );
}
