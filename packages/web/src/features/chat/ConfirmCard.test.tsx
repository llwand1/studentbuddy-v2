// @vitest-environment jsdom
/**
 * ConfirmCard.test — 确认门卡的渲染锁（契约 TOOL-ECOSYSTEM-SPEC §5.1 四硬要求、§6.4 交互）。
 *
 * 这是「用户替 AI 拍板」的界面，硬要求缺一条确认就形同走过场，故逐条上锁：
 * ①动作一句话 ②条数 ③清单 ④「拒绝后不会重复发起」的说明。
 * 另锁三条行为：按钮回执的确切 decision 值、busy 锁防连点、
 * **倒计时归零不许本地代答**（裁决权在服务端定时器，卡片只改文案不改可点性）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ConfirmCard, confirmResultText } from './ConfirmCard';
import type { ConfirmItem } from './useConfirmQueue';

const base: ConfirmItem = {
  requestId: 'r1',
  tool: 'delete_terms',
  source: 'builtin',
  actionSummary: '删除 3 条过期词条',
  affected: 3,
  items: ['闭包', '柯里化', '…等 3 条'],
  expiresAt: 10_000,
  decision: null,
};

function setup(
  over: Partial<ConfirmItem> = {},
  now: number = 8_000,
): { onReply: ReturnType<typeof vi.fn>; onDismiss: ReturnType<typeof vi.fn> } {
  const onReply = vi.fn();
  const onDismiss = vi.fn();
  render(
    <ConfirmCard request={{ ...base, ...over }} now={now} onReply={onReply} onDismiss={onDismiss} />,
  );
  return { onReply, onDismiss };
}

const text = () => document.body.textContent ?? '';

afterEach(() => {
  cleanup();
});

describe('挂起态：§5.1 四硬要求', () => {
  it('动作一句话 + 影响条数 + 逐行清单 + 「不会重复发起」说明，一条不缺', () => {
    setup();
    expect(text()).toContain('删除 3 条过期词条');
    expect(text()).toContain('影响 3 条');
    expect(text()).toContain('闭包');
    expect(text()).toContain('柯里化');
    expect(text()).toContain('不会重复发起');
  });

  it('内置工具用中文名；MCP 工具必须带 server 名（「谁在动手」要看得见）', () => {
    setup();
    expect(text()).toContain('删除词条');
    cleanup();
    setup({ source: 'mcp', server: 'fs-lab', tool: 'fs.write' });
    expect(text()).toContain('fs-lab');
    expect(text()).toContain('fs.write');
  });

  it('三档回执各归各值：允许这次 / 本会话允许 / 拒绝（各自新卡，busy 锁会禁掉其余按钮）', () => {
    const cases: Array<[string, 'allow_once' | 'allow_session' | 'deny']> = [
      ['.confirm-btn.ok', 'allow_once'],
      ['.confirm-btn.ghost', 'allow_session'],
      ['.confirm-btn.bad', 'deny'],
    ];
    for (const [sel, decision] of cases) {
      const { onReply } = setup();
      fireEvent.click(document.querySelector(sel)!);
      expect(onReply).toHaveBeenCalledWith('r1', decision);
      cleanup();
    }
  });

  it('busy 锁：连点两下只发一次（最终裁决仍由服务端广播改态）', () => {
    const { onReply } = setup();
    const okBtn = document.querySelector<HTMLButtonElement>('.confirm-btn.ok')!;
    fireEvent.click(okBtn);
    fireEvent.click(okBtn);
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(okBtn.disabled).toBe(true);
  });

  it('倒计时是显示件：剩 2.1s 念「剩 3 秒」；归零只切文案，按钮保持可点', () => {
    setup({}, base.expiresAt - 2_100);
    expect(text()).toContain('剩 3 秒');
    cleanup();
    const { onReply } = setup({}, base.expiresAt);
    expect(text()).toContain('正在按拒绝收口');
    fireEvent.click(document.querySelector('.confirm-btn.ok')!);
    expect(onReply).toHaveBeenCalledTimes(1); // 前端绝不本地代答 timeout，也绝不提前锁死
  });
});

describe('已裁决态', () => {
  it('deny：结果如实念 + 收起走 onDismiss', () => {
    const { onDismiss } = setup({ decision: 'deny' });
    expect(text()).toContain('已拒绝，AI 不会重复发起');
    expect(document.querySelector('.confirm-btns')).toBeNull(); // 裁决后不再给按钮入口
    fireEvent.click(document.querySelector('.choice-dismiss')!);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('timeout 与 deny 不同文案：点破「60 秒未裁决按拒绝处理」', () => {
    setup({ decision: 'timeout' });
    expect(text()).toContain('60 秒未裁决');
    expect(confirmResultText('timeout')).toContain('按拒绝处理');
  });

  it('allow_session 说明只对本会话同类生效（授权不跨工具蔓延的 UI 镜像）', () => {
    expect(confirmResultText('allow_session')).toContain('本会话内同工具');
    expect(confirmResultText('allow_once')).toContain('正按批准的方案继续');
  });
});
