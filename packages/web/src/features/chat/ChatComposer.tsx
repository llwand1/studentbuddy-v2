/**
 * ChatComposer — 对话页输入区：输入框 + 「+」折叠菜单 + 文档模式 pill/面板 + 本轮出题提示。
 *
 * 2026-09-13 老板口述改版：改版前这一行并排着「出题」「联网」「存入记忆」「导出」四个按钮，
 * 外加单独一行的「文档模式」——输入框被挤成一条缝。改后动作全部收进「+」菜单
 * （WorkBuddy / ChatGPT 同款范式）。★ **动作可以折叠，状态不能藏**：联网开没开、本会话
 * 载没载资料都是状态，故由 `composer-status.ts` 汇总成摘要挂在触发器上，不点开也看得见。
 *
 * 为什么单独成文件：ChatView 已贴 300 行门禁（gates 第 1 条：web 组件 ≤300 行），
 * 这段 JSX 留在原处必然超线。判定逻辑仍按测试方案 §7 约定放可测纯函数
 * （`composer-status.ts`），本组件只排版、不判。
 *
 * 菜单是**可扩展数组**：以后加功能＝往 `items` 里加一项，本文件与 `components/ComposerMenu.tsx`
 * 都不用动（老板明确要求「之后的功能也要预留」）。
 *
 * 触发器只在 `sessionId === null` 时整体禁用：那时菜单里每一项都确实不可用（出题/记忆/文档都要
 * 会话，导出也没有内容）。**生成中不禁用整个菜单**——出题、存入记忆、文档会各自禁用，但导出与
 * 联网开关仍可用（ADR-5：能做的别藏着）。
 */
import type { ComponentProps, RefObject } from 'react';
import { ComposerMenu, type ComposerMenuItem } from '../../components/ComposerMenu';
import { QuizIcon, CardsIcon, DownloadIcon, DocIcon, SendIcon, StopIcon } from '../../components/icons';
import type { AskChoiceRecord } from '@sb/shared';
import { AskStyleCard } from './AskStyleCard';
import { ChoiceCard } from './ChoiceCard';
import { DocModeControl } from './DocModeControl';
import { menuStatus } from './composer-status';
import type { DocMode } from './useDocMode';

/** 选项卡的 props（`busy` 由本组件按出题态统一给，故排除掉） */
type AskCardProps = Omit<ComponentProps<typeof AskStyleCard>, 'busy'>;

export function ChatComposer({
  sessionId,
  blocked,
  busy,
  input,
  setInput,
  inputRef,
  onSubmit,
  onStop,
  quizzing,
  onQuiz,
  online,
  setOnline,
  remembering,
  onRemember,
  onExport,
  canExport,
  doc,
  docOpen,
  setDocOpen,
  showJump,
  onJump,
  statusHint,
  mixTip,
  askSummary,
  askHint,
  askCard,
  choiceCard,
  onChoiceReply,
  onDismissChoice,
}: {
  sessionId: string | null;
  /** 门控：连接未就绪或正在生成（textarea 与部分动作据此禁用） */
  blocked: boolean;
  busy: boolean;
  input: string;
  setInput: (v: string) => void;
  inputRef: RefObject<HTMLTextAreaElement>;
  onSubmit: () => void;
  onStop: () => void;
  quizzing: boolean;
  onQuiz: () => void;
  online: boolean;
  setOnline: (v: boolean) => void;
  remembering: boolean;
  onRemember: () => void;
  onExport: () => void;
  canExport: boolean;
  /** 文档模式的状态与动作；触发器在菜单里、pill 与面板在 composer 上方，两边同一份 */
  doc: DocMode;
  docOpen: boolean;
  setDocOpen: (v: boolean) => void;
  showJump: boolean;
  onJump: () => void;
  statusHint: string;
  mixTip: string;
  askSummary: string;
  askHint: string;
  askCard: AskCardProps | null;
  /** 挂起的方案选择（浮层，显示在输入框上方）；无挂起时为 null */
  choiceCard: AskChoiceRecord | null;
  onChoiceReply: (requestId: string, reply: { optionId?: string; custom?: string }) => void;
  onDismissChoice: () => void;
}) {
  const items: ComposerMenuItem[] = [
    {
      kind: 'action',
      key: 'quiz',
      label: quizzing ? '出题中…' : '出题',
      icon: <QuizIcon />,
      title: mixTip
        ? `基于当前对话一键出题，按配比出：${mixTip}（设置页可改）`
        : '基于当前对话一键出题（输入框文字作为主题）',
      disabled: !sessionId || quizzing || blocked,
      onClick: onQuiz,
    },
    {
      kind: 'toggle',
      key: 'online',
      label: '联网搜索',
      title: '出题前先联网检索资料（用设置页里配的搜索 key）；一条也没搜到时退回模型自身知识，不会因此失败',
      disabled: quizzing,
      on: online,
      onChange: setOnline,
    },
    {
      kind: 'action',
      key: 'doc',
      label: doc.meta ? '换资料' : '文档模式',
      icon: <DocIcon />,
      title: doc.meta
        ? `换资料：载入新资料会替换本会话当前的「${doc.meta.name}」。回答优先依据资料，超长资料按提问检索段落`
        : '为会话载入一篇 txt/md 资料，回答优先依据它（超长资料按提问检索段落；每次一份，可替换/清除）',
      disabled: !sessionId || doc.busy || blocked,
      onClick: () => setDocOpen(!docOpen),
    },
    {
      kind: 'action',
      key: 'remember',
      label: remembering ? '收集中…' : '存入记忆',
      icon: <CardsIcon />,
      title: '把最近对话中的重要术语存入词条库，后续回答优先使用',
      disabled: !sessionId || remembering || blocked,
      onClick: onRemember,
    },
    {
      kind: 'action',
      key: 'export',
      label: '导出对话',
      icon: <DownloadIcon />,
      title: '把当前对话导出为 Markdown（含时间与角色，可直接贴进笔记）',
      disabled: !sessionId || !canExport,
      onClick: onExport,
    },
  ];

  return (
    <div className="chat-composer-wrap">
      {showJump && (
        <button type="button" className="chat-jump" onClick={onJump}>
          ↓ 回到最新
        </button>
      )}
      {statusHint && <div className="chat-conn-hint">{statusHint}</div>}
      {mixTip && sessionId && (
        <div className="chat-quiz-mix">
          出题配比：{mixTip}
          {askSummary && <>｜回答方式：{askSummary}</>}
          <span className="chat-quiz-mix-sep">·</span>
          设置页可改
        </div>
      )}
      {askHint && <div className="ask-style-hint">{askHint}</div>}
      {askCard && <AskStyleCard {...askCard} busy={quizzing} />}
      {choiceCard && <ChoiceCard request={choiceCard} onReply={onChoiceReply} onDismiss={onDismissChoice} />}
      <DocModeControl doc={doc} open={docOpen} onClose={() => setDocOpen(false)} />
      <div className="chat-composer">
        <ComposerMenu
          items={items}
          status={menuStatus({ online, docBase: doc.meta?.name })}
          title="更多功能"
          disabled={!sessionId}
        />
        <textarea
          ref={inputRef}
          value={input}
          placeholder={
            sessionId === null
              ? '点一张建议卡先起个头（会自动开新会话）'
              : blocked
                ? busy
                  ? '生成中…'
                  : '连接未就绪…'
                : '问点什么（Enter 发送 / Shift+Enter 换行）'
          }
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 输入法组字期间的回车是「选词确认」而不是「发送」：没有这道判断，
            // 中文用户打完拼音按回车上屏的瞬间就会把半成品发出去（keydown 仍会触发）
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
        {busy ? (
          <button className="chat-stop" onClick={onStop} title="停止生成" aria-label="停止生成">
            <StopIcon size={14} />
          </button>
        ) : (
          <button className="chat-send" disabled={!input.trim() || blocked} onClick={onSubmit} title="发送">
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  );
}
