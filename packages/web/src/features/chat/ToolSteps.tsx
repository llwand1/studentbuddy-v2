/**
 * ToolSteps —— 工具执行过程卡片（对标 WorkBuddy/Coze 的运行反馈条）。
 * 从 ChatView 抽出（ChatView 门禁 300 行）并升级交互：
 * - running：spinner 转圈 + detail 实时刷新（「正在搜索 xxx」）
 * - done/error：✓/✗ 收口；**点击整行展开**看工具入参（args）与结果摘要（result）
 * - 本轮 done 后不清空（useChatStream 策略）：过程卡片是这轮回答的执行痕迹，可回看
 */
import { useState } from 'react';
import type { ToolStep } from './useChatStream';
import { toolLabel } from './chat-meta';
import './chat-extras.css';

const STATE_TEXT: Record<ToolStep['status'], string> = {
  running: '进行中…',
  done: '完成',
  error: '失败',
};

/** 入参 JSON 美化：坏 JSON 原样展示（模型偶发不合法入参，不上屏报错） */
function prettyArgs(args?: string): string {
  if (!args) return '';
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

export function ToolSteps({ steps }: { steps: ToolStep[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  if (steps.length === 0) return null;

  return (
    <div className="chat-steps">
      {steps.map((s, i) => {
        const open = openIdx === i;
        const expandable = Boolean(s.args || s.result);
        return (
          <div key={i} className={`chat-step ${s.status}${open ? ' open' : ''}`}>
            <button
              type="button"
              className="chat-step-row"
              onClick={() => expandable && setOpenIdx(open ? null : i)}
              aria-expanded={open}
              disabled={!expandable}
              title={expandable ? '点击展开输入 / 输出' : undefined}
            >
              <span className={`chat-step-icon ${s.status}`} aria-hidden>
                {s.status === 'running' ? <span className="chat-step-spinner" /> : s.status === 'done' ? '✓' : '✕'}
              </span>
              <span className="chat-step-name">{toolLabel(s.tool)}</span>
              <span className="chat-step-state">{STATE_TEXT[s.status]}</span>
              {s.detail && <span className="chat-step-detail">{s.detail}</span>}
              {expandable && <span className="chat-step-caret">{open ? '收起' : '详情'}</span>}
            </button>
            {open && (
              <div className="chat-step-payload">
                {s.args && (
                  <>
                    <div className="chat-step-payload-label">输入</div>
                    <pre>{prettyArgs(s.args)}</pre>
                  </>
                )}
                {s.result && (
                  <>
                    <div className="chat-step-payload-label">输出</div>
                    <pre>{s.result}</pre>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
