/**
 * chat-menu —— ChatComposer「+」菜单条目的构造（纯函数，图标内联）。
 *
 * 为什么拆：ChatComposer 296/300 贴 web 组件行数红线，M3 情景题要加第 8 个条目；
 * 菜单构造整体挪过来（挪移不改任何既有条目的行为），既有条目与新增条目都在这一处登记——
 * 「菜单是可扩展数组」的扩展点从此有了单一事实源。
 */
import type { ComposerMenuItem } from '../../components/ComposerMenu';
import { QuizIcon, CardsIcon, DownloadIcon, DocIcon, FlaskIcon } from '../../components/icons';
import type { DocMode } from './useDocMode';

export interface ComposerMenuDeps {
  sessionId: string | null;
  blocked: boolean;
  quizzing: boolean;
  onQuiz: () => void;
  /** 情景题（M3，契约 docs/SCENARIO-SPEC.md §8）：生成中禁发、入口随时可见 */
  scenarioing: boolean;
  onScenario: () => void;
  online: boolean;
  setOnline: (v: boolean) => void;
  /** 出题配比摘要（quiz 条目的 title 会带出它；空则用通用文案） */
  mixTip: string;
  grillMe: boolean;
  setGrillMe: (v: boolean) => void;
  doc: DocMode;
  docOpen: boolean;
  setDocOpen: (v: boolean) => void;
  remembering: boolean;
  onRemember: () => void;
  onExport: () => void;
  canExport: boolean;
  onPickImages: () => void;
}

export function buildComposerMenuItems(d: ComposerMenuDeps): ComposerMenuItem[] {
  return [
    {
      kind: 'action',
      key: 'quiz',
      label: d.quizzing ? '出题中…' : '出题',
      icon: <QuizIcon />,
      title: d.mixTip
        ? `基于当前对话一键出题，按配比出：${d.mixTip}（设置页可改）`
        : '基于当前对话一键出题（输入框文字作为主题）',
      disabled: !d.sessionId || d.quizzing || d.blocked,
      onClick: d.onQuiz,
    },
    {
      kind: 'action',
      key: 'scenario',
      label: d.scenarioing ? '出情景题…' : '情景题',
      icon: <FlaskIcon />,
      title: 'AI 生成一个可交互 demo 情景题，在里面动手做，对错自动计入统计（输入框文字作为主题）',
      disabled: !d.sessionId || d.scenarioing || d.blocked,
      onClick: d.onScenario,
    },
    {
      kind: 'toggle',
      key: 'online',
      label: '联网搜索',
      title: '出题前先联网检索资料（用设置页里配的搜索 key）；一条也没搜到时退回模型自身知识，不会因此失败',
      disabled: d.quizzing,
      on: d.online,
      onChange: d.setOnline,
    },
    {
      kind: 'toggle',
      key: 'grill',
      label: 'grill-me 追问',
      title:
        '每轮都先让 AI 抛 2~4 个方向让你拍板，讲完再问下一步（工程强绑，不靠它自觉）；' +
        '不点选项或点「跳过」即跳过。仅当前会话有效，切会话重置',
      on: d.grillMe,
      onChange: d.setGrillMe,
    },
    {
      kind: 'action',
      key: 'doc',
      label: d.doc.meta ? '换资料' : '文档模式',
      icon: <DocIcon />,
      title: d.doc.meta
        ? `换资料：载入新资料会替换本会话当前的「${d.doc.meta.name}」。回答优先依据资料，超长资料按提问检索段落`
        : '为会话载入一篇 txt/md 资料，回答优先依据它（超长资料按提问检索段落；每次一份，可替换/清除）',
      disabled: !d.sessionId || d.doc.busy || d.blocked,
      onClick: () => d.setDocOpen(!d.docOpen),
    },
    {
      kind: 'action',
      key: 'remember',
      label: d.remembering ? '收集中…' : '存入记忆',
      icon: <CardsIcon />,
      title: '把最近对话中的重要术语存入词条库，后续回答优先使用',
      disabled: !d.sessionId || d.remembering || d.blocked,
      onClick: d.onRemember,
    },
    {
      kind: 'action',
      key: 'export',
      label: '导出对话',
      icon: <DownloadIcon />,
      title: '把当前对话导出为 Markdown（含时间与角色，可直接贴进笔记）',
      disabled: !d.sessionId || !d.canExport,
      onClick: d.onExport,
    },
    {
      kind: 'action',
      key: 'image',
      label: '图片',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="M21 16l-5-5-7 7" />
        </svg>
      ),
      title: '上传图片让 AI 看图（需在设置页为「视觉（看图）」角色绑定一个支持图片的模型，如 qwen-vl-plus / gpt-4o / glm-4v）',
      disabled: !d.sessionId || d.blocked,
      onClick: d.onPickImages,
    },
  ];
}
