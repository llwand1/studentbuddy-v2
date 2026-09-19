/**
 * ToolSteps —— 工具执行过程卡片（对标 WorkBuddy/Coze 的运行反馈条）。
 * 从 ChatView 抽出（ChatView 门禁 300 行）并升级交互：
 * - running：spinner 转圈 + detail 实时刷新（「正在搜索 xxx」）+ 本地 1s tick 秒表
 * - done/error：✓/✗ 收口；**点击整行展开**看工具入参（args）、结果摘要（result）、失败原因（errorText）
 * - 耗时徽标（P1，契约 TOOL-ECOSYSTEM-SPEC §4.7）：**只在终态显示服务端实测值**；
 *   running 期显示的是前端本地 tick（assistant-ui 口径：timing 只在流结束定稿，live badge
 *   自己起 timer），终态帧到达即被 durationMs 取代。缺 durationMs（老历史/没测到）退「无徽标」，
 *   绝不显示「0 秒」。
 * - 本轮 done 后不清空（useChatStream 策略）：过程卡片是这轮回答的执行痕迹，可回看
 */
import { useEffect, useState } from 'react';
import type { ToolStep } from './useChatStream';
import { toolLabel } from './chat-meta';
import { formatDuration } from './thinking-status';
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

/** running 徽标的本地 tick：整秒起步（真值终态由服务端 durationMs 覆盖，精度无意义） */
function tickText(startedAtMs: number | undefined, now: number): string {
  if (!startedAtMs || now <= startedAtMs) return '';
  return `${Math.floor((now - startedAtMs) / 1000)}s`;
}

export function ToolSteps({ steps }: { steps: ToolStep[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const hasRunning = steps.some((s) => s.status === 'running');
  // 只有存在进行中卡片时才开 1s timer；全部收口即停摆，不陪跑空转
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!hasRunning) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasRunning]);
  if (steps.length === 0) return null;

  return (
    <div className="chat-steps">
      {steps.map((s, i) => {
        const open = openIdx === i;
        const expandable = Boolean(s.args || s.result || s.errorText);
        const dur = s.status === 'running' ? tickText(s.startedAtMs, now) : s.durationMs != null ? formatDuration(s.durationMs) : '';
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
              {dur && <span className="chat-step-duration">{dur}</span>}
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
                {s.errorText && (
                  <>
                    <div className="chat-step-payload-label">失败原因</div>
                    <pre className="chat-step-error-text">{s.errorText}</pre>
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
