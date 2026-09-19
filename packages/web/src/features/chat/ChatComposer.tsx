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
import { useRef, type ComponentProps, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { ComposerMenu } from '../../components/ComposerMenu';
import { SendIcon, StopIcon } from '../../components/icons';
import { buildComposerMenuItems } from './chat-menu';
import type { AskChoiceRecord } from '@sb/shared';
import { AskStyleCard } from './AskStyleCard';
import { ChoiceCard } from './ChoiceCard';
import { DocModeControl } from './DocModeControl';
import { menuStatus } from './composer-status';
import { GrillPill } from './GrillPill';
import { AttachmentTray } from './AttachmentTray';
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
  attachments,
  setAttachments,
  grillMe,
  setGrillMe,
  onSubmit,
  onStop,
  quizzing,
  onQuiz,
  scenarioing,
  onScenario,
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
  /** v17 看图：待发送图片（base64 dataURL），由 ChatView 持有并随发送清空 */
  attachments: Array<{ dataUrl: string; name?: string }>;
  setAttachments: Dispatch<SetStateAction<Array<{ dataUrl: string; name?: string }>>>;
  /** v18 grill-me：打开后每轮必出方案选择框（会话级前端状态，不落库） */
  grillMe: boolean;
  setGrillMe: (v: boolean) => void;
  onSubmit: () => void;
  onStop: () => void;
  quizzing: boolean;
  onQuiz: () => void;
  /** 情景题（M3）：生成中禁发；生成与错误都在 ChatView 侧 */
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
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const MAX_IMAGES = 4;
  /**
   * 已发起读取、还没落进 attachments 的张数。★ 上限必须把它算进来：`attachments` 是**本次渲染的
   * 快照**，连续两次粘贴/选图在同一 tick 内都读到旧值，只按它算余量的话 4 张的上限会被突破
   * （服务端 `chat/vision.ts` 与 24mb body 限额是同一套账，超了的症状是「点发送没反应」）。
   */
  const inflight = useRef(0);

  /** 把选中的/粘贴的图片文件转 base64 dataURL 追加进附件（上限 4 张，非图片忽略） */
  const addImages = (files: File[]) => {
    const room = MAX_IMAGES - attachments.length - inflight.current;
    if (room <= 0) return;
    for (const file of files.filter((f) => f.type.startsWith('image/')).slice(0, room)) {
      inflight.current += 1;
      const reader = new FileReader();
      const release = () => {
        inflight.current -= 1;
      };
      reader.onload = () => {
        release();
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        // 函数式更新里再兜一次硬上限：名额计数若与真实状态对不上，宁可丢弃也不越线
        if (dataUrl) setAttachments((a) => (a.length >= MAX_IMAGES ? a : [...a, { dataUrl, name: file.name }]));
      };
      reader.onerror = release; // 读失败也要还名额，否则余量永久缩水
      reader.readAsDataURL(file);
    }
  };

  const items = buildComposerMenuItems({
    sessionId,
    blocked,
    quizzing,
    onQuiz,
    scenarioing,
    onScenario,
    online,
    setOnline,
    mixTip,
    grillMe,
    setGrillMe,
    doc,
    docOpen,
    setDocOpen,
    remembering,
    onRemember,
    onExport,
    canExport,
    onPickImages: () => fileRef.current?.click(),
  });

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
      {grillMe && <GrillPill onClose={() => setGrillMe(false)} />}
      {askCard && <AskStyleCard {...askCard} busy={quizzing} />}
      {/* grill-me 的卡**不在这里**浮——它渲染在消息流里（见 ChatView）。
          同一次提问若两边都渲染，用户会看到两张一模一样的卡 */}
      {choiceCard && !choiceCard.grillPhase && (
        <ChoiceCard request={choiceCard} onReply={onChoiceReply} onDismiss={onDismissChoice} />
      )}
      <DocModeControl doc={doc} open={docOpen} onClose={() => setDocOpen(false)} />
      <AttachmentTray images={attachments} onRemove={(i) => setAttachments(attachments.filter((_, j) => j !== i))} />
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
                : '问点什么（Enter 发送 / Shift+Enter 换行，可直接粘贴图片）'
          }
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
    </div>
  );
}
