/**
 * ChatComposer — 对话页输入区：输入框 + 「+」折叠菜单 + 文档模式 pill/面板 + 本轮出题提示。
 *
 * 2026-09-13 改版：改版前这一行并排着「出题」「联网」「存入记忆」「导出」四个按钮，
 * 外加单独一行的「文档模式」——输入框被挤成一条缝。改后动作全部收进「+」菜单
 * （WorkBuddy / ChatGPT 同款范式）。★ **动作可以折叠，状态不能藏**：联网开没开、本会话
 * 载没载资料都是状态，故由 `composer-status.ts` 汇总成摘要挂在触发器上，不点开也看得见。
 *
 * 为什么单独成文件：ChatView 已贴 300 行门禁（gates 第 1 条：web 组件 ≤300 行），
 * 这段 JSX 留在原处必然超线。判定逻辑仍按测试方案 §7 约定放可测纯函数
 * （`composer-status.ts`），本组件只排版、不判。
 *
 * 菜单是**可扩展数组**：以后加功能＝往 `items` 里加一项，本文件与 `components/ComposerMenu.tsx`
 * 都不用动（「之后的功能也要预留」）。
 *
 * 触发器只在 `sessionId === null` 时整体禁用：那时菜单里每一项都确实不可用（出题/记忆/文档都要
 * 会话，导出也没有内容）。**生成中不禁用整个菜单**——出题、存入记忆、文档会各自禁用，但导出与
 * 联网开关仍可用（ADR-5：能做的别藏着）。
 * ★ 但输入框与发送键在无会话时**不禁**（CHAT-UX §2.9 空会话直接开聊）：发送即开新对话，`blocked`
 *   由 ChatView 按「开会话中」给；占位文案把这条路写出来，而不是让人去找「新建对话」。
 */
import { type ComponentProps, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { ComposerMenu } from '../../components/ComposerMenu';
import { SendIcon, StopIcon } from '../../components/icons';
import { buildComposerMenuItems } from './chat-menu';
import { hasHost } from '../float/float-view';
import { requestDesktopCapture } from '../desktop/desktop-input';
import { requestDesktopReader } from '../desktop/desktop-reader-store';
import type { AskChoiceRecord, ToolConfirmDecision } from '@sb/shared';
import { useComposerImages } from './useComposerImages';
import { DesktopComposerBridge } from '../desktop/DesktopComposerBridge';
import { AskStyleCard } from './AskStyleCard';
import { ComposerRequests } from './ComposerRequests';
import { ComposerDock } from './ComposerDock';
import type { ConfirmItem } from './useConfirmQueue';
import { DocModeControl } from './DocModeControl';
import { menuStatus } from './composer-status';
import { GrillPill } from './GrillPill';
import type { GrillScope, GrillTiming } from '@sb/shared';
import { DrillParkedPill } from '../drill/DrillParkedPill';
import { AttachmentTray } from './AttachmentTray';
import type { DocMode } from './useDocMode';
import { QuizGenerating } from '../quiz/QuizGenerating';
import { composerPlaceholder } from './composer-placeholder';
import { useNarrow } from '../../lib/use-narrow';

/** 选项卡的 props（`busy` 由本组件按出题态统一给，故排除掉） */
type AskCardProps = Omit<ComponentProps<typeof AskStyleCard>, 'busy'>;

export function ChatComposer({
  sessionId,
  blocked,
  busy,
  input,
  setInput,
  inputRef,
  attachments,
  setAttachments,
  grillMe,
  setGrillMe,
  grillScope,
  setGrillScope,
  grillTiming,
  setGrillTiming,
  onSubmit,
  onStop,
  quizzing,
  onQuiz,
  scenarioing,
  online,
  setOnline,
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
  confirmCard,
  confirmNowMs,
  onConfirmReply,
  onDismissConfirm,
}: {
  sessionId: string | null;
  /** 门控：连接未就绪或正在生成（textarea 与部分动作据此禁用） */
  blocked: boolean;
  busy: boolean;
  input: string;
  setInput: (v: string) => void;
  inputRef: RefObject<HTMLTextAreaElement>;
  /** v17 看图：待发送图片（base64 dataURL），由 ChatView 持有并随发送清空 */
  attachments: Array<{ dataUrl: string; name?: string }>;
  setAttachments: Dispatch<SetStateAction<Array<{ dataUrl: string; name?: string }>>>;
  /** v18 grill-me：打开后每轮必出方案选择框（会话级前端状态，不落库） */
  grillMe: boolean;
  setGrillMe: (v: boolean) => void;
  grillScope?: GrillScope;
  setGrillScope?: (scope: GrillScope) => void;
  grillTiming?: GrillTiming;
  setGrillTiming?: (timing: GrillTiming) => void;
  onSubmit: () => void;
  onStop: () => void;
  quizzing: boolean;
  onQuiz: () => void;
  /** 情景题：生成中禁发；生成与错误都在 ChatView 侧 */
  scenarioing: boolean;
  onScenario: () => void;
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
  /** 挂起的工具确认（确认门浮层；心跳由 useConfirmQueue 单点推进） */
  confirmCard: ConfirmItem | null;
  confirmNowMs: number;
  onConfirmReply: (requestId: string, decision: ToolConfirmDecision) => void;
  onDismissConfirm: () => void;
}) {
  const { fileRef, intakeHint, addImages } = useComposerImages(attachments, setAttachments);

  const items = buildComposerMenuItems({ sessionId, blocked, quizzing, onQuiz, online, setOnline, mixTip,
    grillMe, setGrillMe, desktop: hasHost(), onReader: requestDesktopReader, onCapture: requestDesktopCapture });

  // 手机宽度下占位文案换短句（docs/MOBILE-SPEC.md §3.1）；布局差异仍在 CSS，这里只管字
  const narrow = useNarrow();

  return (
    <div className="chat-composer-wrap">
      <DesktopComposerBridge input={input} setInput={setInput} inputRef={inputRef} attachments={attachments} setAttachments={setAttachments} />
      {/* 生成中离底：按钮点亮成「新内容」——提示底下还在长，而不只是「你滚上来了」 */}
      {showJump && (
        <button type="button" className={busy ? 'chat-jump live' : 'chat-jump'} onClick={onJump}>
          {busy ? '↓ 新内容' : '↓ 回到最新'}
        </button>
      )}
      {statusHint && <div className="chat-conn-hint">{statusHint}</div>}
      {(quizzing || scenarioing) && <QuizGenerating scenario={scenarioing} />}
      {mixTip && sessionId && (
        <div className="chat-quiz-mix">
          出题配比：{mixTip}
          {askSummary && <>｜回答方式：{askSummary}</>}
          <span className="chat-quiz-mix-sep">·</span>
          设置页可改
        </div>
      )}
      <ComposerRequests ask={askCard ? { ...askCard, busy: quizzing } : null}
        confirm={confirmCard ? { request: confirmCard, now: confirmNowMs, onReply: onConfirmReply, onDismiss: onDismissConfirm } : null}
        choice={choiceCard && !choiceCard.grillPhase ? { request: choiceCard, onReply: onChoiceReply, onDismiss: onDismissChoice } : null} />
      <ComposerDock busy={busy} draft={!!input.trim() || attachments.length > 0} onStop={onStop}>
      {askHint && <div className="ask-style-hint">{askHint}</div>}
      {grillMe && <GrillPill scope={grillScope} onScopeChange={setGrillScope} timing={grillTiming} onTimingChange={setGrillTiming} disabled={busy || blocked} onClose={() => setGrillMe(false)} />}
      <DrillParkedPill />
      <DocModeControl doc={doc} open={docOpen} onClose={() => setDocOpen(false)} />
      <AttachmentTray images={attachments} onRemove={(i) => setAttachments(attachments.filter((_, j) => j !== i))} />
      {intakeHint && <div className="chat-att-hint">{intakeHint}</div>}
      <div className={busy ? 'chat-composer busy' : 'chat-composer'}>
        <ComposerMenu
          items={items}
          status={menuStatus({ online, docBase: doc.meta?.name })}
          title="更多功能"
          disabled={!sessionId && !hasHost()}
        />
        <textarea
          ref={inputRef}
          value={input}
          placeholder={composerPlaceholder({ sessionId, blocked, busy, narrow })}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            // 粘贴图片 = 直接附图（与「+ 图片」同一条路）；非图片粘贴交回默认行为
            const files = Array.from(e.clipboardData?.items ?? [])
              .filter((it) => it.type.startsWith('image/'))
              .map((it) => it.getAsFile())
              .filter((f): f is File => !!f);
            if (files.length > 0) {
              e.preventDefault();
              addImages(files);
            }
          }}
          onKeyDown={(e) => {
            // 输入法组字期间的回车是「选词确认」而不是「发送」：没有这道判断，
            // 中文用户打完拼音按回车上屏的瞬间就会把半成品发出去（keydown 仍会触发）
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
            // 生成中按 Esc ＝ 点「停止」：焦点本来就在输入框，不用挪鼠标去够按钮
            if (e.key === 'Escape' && busy) {
              e.preventDefault();
              onStop();
            }
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            addImages(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        {busy ? (
          <button type="button" className="chat-stop" onClick={onStop} title="停止生成" aria-label="停止生成">
            <StopIcon size={14} />
          </button>
        ) : (
          <button
            type="button"
            className="chat-send"
            disabled={!input.trim() || blocked}
            onClick={onSubmit}
            title="发送"
          >
            <SendIcon />
          </button>
        )}
      </div>
      </ComposerDock>
    </div>
  );
}
