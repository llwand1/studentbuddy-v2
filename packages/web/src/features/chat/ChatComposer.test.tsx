// @vitest-environment jsdom
/**
 * ChatComposer.test — 输入区组件级回归锁。
 *
 * 判定逻辑（menuStatus 等）已有纯函数测试兜着；这里锁的是**渲染与交互契约**：
 * 三态 placeholder、发送/停止按钮互换、IME 组字回车不误发（中文用户的事故位）、
 * 菜单在无会话时整体禁用、mixTip 的会话门、附件移除回传、**附件 4 张上限的同一 tick 竞态**。
 * 纯函数测试测不到「按钮换没换」「占位文案给没给对」「连粘两次会不会超上限」这一层。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { render, fireEvent, screen, cleanup, type RenderResult } from '@testing-library/react';
import { ChatComposer } from './ChatComposer';
import type { DocMode } from './useDocMode';

afterEach(cleanup);

function stubDoc(): DocMode {
  return {
    meta: null,
    dn: null,
    name: '',
    setName: () => {},
    text: '',
    setText: () => {},
    busy: false,
    hint: '',
    overCap: false,
    submit: async () => {},
    onPickFile: async () => {},
    clear: async () => {},
  };
}

type ComposerProps = Parameters<typeof ChatComposer>[0];

function base(over: Partial<ComposerProps> = {}): ComposerProps {
  return {
    sessionId: 's1',
    blocked: false,
    busy: false,
    input: '',
    setInput: vi.fn(),
    inputRef: { current: null },
    attachments: [],
    setAttachments: vi.fn(),
    grillMe: false,
    setGrillMe: vi.fn(),
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    quizzing: false,
    onQuiz: vi.fn(),
    scenarioing: false,
    onScenario: vi.fn(),
    online: false,
    setOnline: vi.fn(),
    remembering: false,
    onRemember: vi.fn(),
    onExport: vi.fn(),
    canExport: false,
    doc: stubDoc(),
    docOpen: false,
    setDocOpen: vi.fn(),
    showJump: false,
    onJump: vi.fn(),
    statusHint: '',
    mixTip: '',
    askSummary: '',
    askHint: '',
    askCard: null,
    choiceCard: null,
    onChoiceReply: vi.fn(),
    onDismissChoice: vi.fn(),
    confirmCard: null,
    confirmNowMs: 0,
    onConfirmReply: vi.fn(),
    onDismissConfirm: vi.fn(),
    ...over,
  };
}

function setup(over: Partial<ComposerProps> = {}): RenderResult & { props: ComposerProps } {
  const props = base(over);
  const r = render(<ChatComposer {...props} />);
  return { ...r, props };
}

const ta = () => screen.getByRole('textbox') as HTMLTextAreaElement;

describe('ChatComposer 输入区', () => {
  it('三态占位文案：无会话 / 连接未就绪 / 生成中各说各话', () => {
    expect(setup({ sessionId: null }).getByPlaceholderText('点一张建议卡先起个头（会自动开新会话）')).toBeTruthy();
    expect(setup({ blocked: true, busy: false }).getByPlaceholderText('连接未就绪…')).toBeTruthy();
    expect(setup({ blocked: true, busy: true }).getByPlaceholderText('生成中…')).toBeTruthy();
    expect(setup({}).getByPlaceholderText(/Enter 发送/)).toBeTruthy();
  });

  it('无会话时「+」菜单触发器整体禁用（每一项都依赖会话，不点亮再让人撞灰）', () => {
    const noSession = setup({ sessionId: null });
    const trigger = noSession.container.querySelector('.composer-menu-btn') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-label')).toBe('更多功能');
    expect(trigger.hasAttribute('disabled')).toBe(true);
    const withSession = setup({});
    const trigger2 = withSession.container.querySelector('.composer-menu-btn') as HTMLButtonElement;
    expect(trigger2.hasAttribute('disabled')).toBe(false);
  });

  it('发送按钮：空输入禁用，输入后放行并回调 onSubmit', () => {
    const { container, props } = setup({});
    const send = container.querySelector('.chat-send') as HTMLButtonElement;
    expect(send.hasAttribute('disabled')).toBe(true);
    const r2 = setup({ input: '你好' });
    const send2 = r2.container.querySelector('.chat-send') as HTMLButtonElement;
    expect(send2.hasAttribute('disabled')).toBe(false);
    fireEvent.click(send2);
    expect(r2.props.onSubmit).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('busy 时发送按钮换成停止按钮（同位互换，不是并排两个）', () => {
    const { container, props } = setup({ busy: true });
    expect(container.querySelector('.chat-send')).toBeNull();
    const stop = container.querySelector('.chat-stop') as HTMLButtonElement;
    expect(stop.getAttribute('aria-label')).toBe('停止生成');
    fireEvent.click(stop);
    expect(props.onStop).toHaveBeenCalledTimes(1);
  });

  it('Enter 发送；Shift+Enter 换行；输入法组字回车不误发', () => {
    const { props } = setup({});
    fireEvent.keyDown(ta(), { key: 'Enter', isComposing: false });
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(ta(), { key: 'Enter', shiftKey: true });
    expect(props.onSubmit).toHaveBeenCalledTimes(1); // 换行不发送
    fireEvent.keyDown(ta(), { key: 'Enter', isComposing: true });
    expect(props.onSubmit).toHaveBeenCalledTimes(1); // 组字确认不是发送
    fireEvent.keyDown(ta(), { key: 'a', isComposing: true });
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  it('输入实时回传 setInput（受控不回弹）', () => {
    const { props } = setup({});
    fireEvent.change(ta(), { target: { value: '问题描述' } });
    expect(props.setInput).toHaveBeenCalledWith('问题描述');
  });

  it('mixTip 只在有会话时显示（配比没有会话可依附就不该出现）', () => {
    const withSession = setup({ mixTip: '易3:中2:难1', askSummary: '简答' });
    expect(withSession.container.querySelector('.chat-quiz-mix')?.textContent).toContain('易3:中2:难1');
    expect(withSession.container.querySelector('.chat-quiz-mix')?.textContent).toContain('回答方式：简答');
    const noSession = setup({ sessionId: null, mixTip: '易3:中2:难1' });
    expect(noSession.container.querySelector('.chat-quiz-mix')).toBeNull();
  });

  it('statusHint 与「回到最新」按 props 出现并可点', () => {
    const { container, props } = setup({ statusHint: '连接已断', showJump: true });
    expect(container.querySelector('.chat-conn-hint')?.textContent).toBe('连接已断');
    const jump = container.querySelector('.chat-jump') as HTMLButtonElement;
    fireEvent.click(jump);
    expect(props.onJump).toHaveBeenCalledTimes(1);
  });

  it('附件托盘渲染图片并可移除（移除回传剔除后的数组）', () => {
    const imgs = [
      { dataUrl: 'data:image/png;base64,AA', name: 'a.png' },
      { dataUrl: 'data:image/png;base64,BB', name: 'b.png' },
    ];
    const { container, props } = setup({ attachments: imgs });
    expect(container.querySelectorAll('.chat-att').length).toBe(2);
    fireEvent.click(container.querySelector('.chat-att-remove') as Element);
    expect(props.setAttachments).toHaveBeenCalledWith([imgs[1]]);
  });

  it('菜单是开关语义：toggle 项点完保持展开，「已开/已关」即时反馈', () => {
    const { props } = setup({});
    fireEvent.click(screen.getByLabelText('更多功能'));
    const item = screen.getByRole('menuitemcheckbox', { name: /联网搜索/ });
    expect(item.textContent).toContain('已关');
    fireEvent.click(item);
    expect(props.setOnline).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('menu')).toBeTruthy(); // toggle 不收菜单（可连翻验证）
  });

  it('发送/停止按钮显式 type="button"（将来外层包进 form 也不会变成提交按钮）', () => {
    const idle = setup({});
    expect(idle.container.querySelector('.chat-send')?.getAttribute('type')).toBe('button');
    const busy = setup({ busy: true });
    expect(busy.container.querySelector('.chat-stop')?.getAttribute('type')).toBe('button');
  });

  /**
   * 附件上限的真竞态位：`attachments` 是**本次渲染的快照**，同一 tick 内两次粘贴都读到旧值。
   * 所以这里必须挂真 `useState`（`vi.fn()` 的 setter 不累加，测的是假状态），
   * 并且两次 paste 之间不给重渲染的机会。
   */
  it('附件上限 4 张锁得住：同一 tick 连续两次各粘 3 张，只收 4 张', async () => {
    function Harness() {
      const [imgs, setImgs] = useState<Array<{ dataUrl: string; name?: string }>>([]);
      return <ChatComposer {...base({ attachments: imgs, setAttachments: setImgs })} />;
    }
    const { container } = render(<Harness />);
    const paste = (n: number, tag: string) => {
      const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
        clipboardData: { items: Array<{ type: string; getAsFile: () => File }> };
      };
      ev.clipboardData = {
        items: Array.from({ length: n }, (_, i) => {
          const f = new File([new Uint8Array([1, 2, 3])], `${tag}${i}.png`, { type: 'image/png' });
          return { type: f.type, getAsFile: () => f };
        }),
      };
      fireEvent(ta(), ev);
    };
    paste(3, 'a');
    paste(3, 'b'); // 此刻 attachments 仍是空数组：只有「在途名额」能挡住这 3 张
    const names = () =>
      Array.from(container.querySelectorAll('.chat-att img')).map((im) => im.getAttribute('alt'));
    await vi.waitFor(() => {
      expect(names().length).toBe(4);
    });
    // 收的是先到的 4 张，越线那张连读取都不该发起
    expect(names()).toEqual(['a0.png', 'a1.png', 'a2.png', 'b0.png']);
  });
});
