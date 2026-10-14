import type { ComposerMenuItem } from '../../components/ComposerMenu';
import { QuizIcon } from '../../components/icons';
export interface ComposerMenuDeps {
  sessionId: string | null; blocked: boolean; quizzing: boolean; onQuiz: () => void;
  online: boolean; setOnline: (v: boolean) => void; mixTip: string;
  grillMe: boolean; setGrillMe: (v: boolean) => void;
  desktop?: boolean; onReader?: () => void; onCapture?: () => void;
}
export function buildComposerMenuItems(d: ComposerMenuDeps): ComposerMenuItem[] {
  const items: ComposerMenuItem[] = [
    { kind: 'action', key: 'quiz', label: d.quizzing ? '出题中…' : '出题', icon: <QuizIcon />,
      title: d.mixTip ? `基于当前对话一键出题，按配比出：${d.mixTip}（设置页可改）` : '基于当前对话一键出题（输入框文字作为主题）',
      disabled: !d.sessionId || d.quizzing || d.blocked, onClick: d.onQuiz },
    { kind: 'toggle', key: 'online', label: '联网搜索', title: '出题前联网检索资料；无结果时退回模型自身知识',
      disabled: d.quizzing, on: d.online, onChange: d.setOnline },
    { kind: 'toggle', key: 'grill', label: 'GrillMe 追问', title: '围绕学习范围按需选择路线，回答后预判下一步',
      on: d.grillMe, onChange: d.setGrillMe },
  ];
  if (d.desktop) items.push(
    { kind: 'action', key: 'reader', label: '网页共读', icon: <span aria-hidden>▤</span>, title: '打开共读浏览器，选好网页后点击开始，无需配置',
      disabled: d.blocked, onClick: () => d.onReader?.() },
    { kind: 'action', key: 'capture', label: '截图', icon: <span aria-hidden>▣</span>, title: '框选本机屏幕，预览后放入输入框，不会自动发送',
      disabled: d.blocked, onClick: () => d.onCapture?.() },
  );
  return items;
}
