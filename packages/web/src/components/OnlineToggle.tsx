/**
 * OnlineToggle — 出题「联网搜索」开关（契约 docs/QUIZ-SEARCH-SPEC.md §2.2，2026-09-13 老板点单）。
 *
 * 题库页与对话页两处出题**共用这一个件**：各写一遍必然漂成两种行为、两套文案
 * （先例 components/StyleChips.tsx —— 设置卡与出题前弹卡同一套渲染）。
 *
 * 默认开：联网出的题才追得上时效（新数据/新概念/新闻事件），关掉＝只用模型自身知识、更快。
 * 不带内联样式，样式自持在 online-toggle.css，不依赖调用方的样式表。
 */
import { SearchIcon } from './icons';
import './online-toggle.css';

export function OnlineToggle({
  on,
  disabled,
  onToggle,
}: {
  on: boolean;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={on ? 'sb-online-pill on' : 'sb-online-pill'}
      aria-pressed={on}
      disabled={disabled}
      title={
        on
          ? '本次出题会先联网检索资料（用设置页里配的搜索 key；一条也没搜到时退回模型自身知识，不会因此失败）'
          : '本次出题不联网，只用模型自身知识（更快）'
      }
      onClick={() => onToggle(!on)}
    >
      <SearchIcon size={13} /> 联网{on ? '已开' : '已关'}
    </button>
  );
}
