// @vitest-environment jsdom
/**
 * guide-store 单测：能力注册表 / 对话现场 / 话题信箱（契约 `docs/GUIDE-SPEC.md` §3）。
 *
 * 锁六条：
 *  ① 登记 ⇒ `kinds` 里出现、按白名单顺序（与登记顺序无关）；注销 ⇒ 消失；
 *  ② 同一种动作多个登记者（一个会话里好几张题卡）：**最近登记的生效**，注销它后退回上一个；
 *  ③ `runGuideCap`：没人登记 ⇒ false（调用方据此说「现在做不了」），有则把文本交给处理器；
 *  ④ ★ 没变就不通知：组件每次渲染都会重新登记处理器，若每次都通知，订阅者会被抖得重渲染不停；
 *  ⑤ 信箱：放进去、取走即清空、重复取为空、超过 5 秒过期当没有（并清掉）；
 *  ⑥ `useGuideLive` 随变化重渲染；`resetGuideStore` 回到出厂状态。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  GUIDE_MAIL_TTL_MS,
  getGuideChat,
  getGuideLive,
  putGuideMail,
  registerGuideCap,
  resetGuideStore,
  runGuideCap,
  setGuideChat,
  subscribeGuide,
  takeGuideMail,
  useGuideLive,
} from './guide-store';

afterEach(() => resetGuideStore());

describe('① 登记与注销', () => {
  it('登记后出现在 kinds 里，顺序按白名单而不是登记先后；注销即消失', () => {
    const offB = registerGuideCap('nav.terms', () => undefined);
    const offA = registerGuideCap('chat.topic', () => undefined);
    expect(getGuideLive().kinds).toEqual(['chat.topic', 'nav.terms']);
    offB();
    expect(getGuideLive().kinds).toEqual(['chat.topic']);
    offA();
    expect(getGuideLive().kinds).toEqual([]);
  });

  it('重复注销同一个登记是空操作，不会误删别人的', () => {
    const off1 = registerGuideCap('quiz.retry', () => undefined);
    registerGuideCap('quiz.retry', () => undefined);
    off1();
    off1();
    expect(getGuideLive().kinds).toEqual(['quiz.retry']);
  });
});

describe('② 最近登记的生效', () => {
  it('两个登记者：执行的是后来的；注销后来的，退回前一个', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerGuideCap('quiz.explain', first);
    const offSecond = registerGuideCap('quiz.explain', second);
    runGuideCap('quiz.explain');
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    offSecond();
    runGuideCap('quiz.explain');
    expect(first).toHaveBeenCalledTimes(1);
    expect(getGuideLive().kinds).toEqual(['quiz.explain']);
  });
});

describe('③ runGuideCap', () => {
  it('没人登记 ⇒ false 且不抛；有 ⇒ true，文本原样交给处理器', () => {
    expect(runGuideCap('quiz.start')).toBe(false);
    const fn = vi.fn();
    registerGuideCap('chat.ask', fn);
    expect(runGuideCap('chat.ask', '再举个例子')).toBe(true);
    expect(fn).toHaveBeenCalledWith('再举个例子');
  });
});

describe('④ 没变就不通知', () => {
  it('同一种动作重复登记（kinds 没变）不通知；现场内容没变不通知；变了才通知', () => {
    const listener = vi.fn();
    const off = subscribeGuide(listener);
    registerGuideCap('nav.cards', () => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
    registerGuideCap('nav.cards', () => undefined); // kinds 没变
    expect(listener).toHaveBeenCalledTimes(1);
    setGuideChat({ sessionId: 's1', rounds: 1, empty: false, busy: false });
    expect(listener).toHaveBeenCalledTimes(2);
    setGuideChat({ sessionId: 's1', rounds: 1, empty: false, busy: false }); // 内容相同的新对象
    expect(listener).toHaveBeenCalledTimes(2);
    setGuideChat({ sessionId: 's1', rounds: 2, empty: false, busy: false });
    expect(listener).toHaveBeenCalledTimes(3);
    off();
  });

  it('快照引用稳定：没变化时读到的永远是同一个对象（useSyncExternalStore 不会死循环）', () => {
    registerGuideCap('nav.pk', () => undefined);
    const a = getGuideLive();
    expect(getGuideLive()).toBe(a);
    registerGuideCap('nav.pk', () => undefined); // kinds 没变
    setGuideChat(null); // 本来就是 null
    expect(getGuideLive()).toBe(a);
  });

  it('对话现场：设置 / 读取 / 撤销', () => {
    setGuideChat({ sessionId: null, rounds: 0, empty: true, busy: false });
    expect(getGuideChat()).toEqual({ sessionId: null, rounds: 0, empty: true, busy: false });
    setGuideChat(null);
    expect(getGuideChat()).toBeNull();
    expect(getGuideLive().chat).toBeNull();
  });
});

describe('⑤ 话题信箱', () => {
  it('放进去 ⇒ 快照里看得见；取走 ⇒ 拿到原文且清空；再取 ⇒ null', () => {
    putGuideMail('为什么天空是蓝色的？');
    expect(getGuideLive().mail).toBe('为什么天空是蓝色的？');
    expect(takeGuideMail()).toBe('为什么天空是蓝色的？');
    expect(getGuideLive().mail).toBeNull();
    expect(takeGuideMail()).toBeNull();
  });

  it('★ 超过 5 秒过期：当没有，并且清掉（过期话题不会在之后某次「删掉当前会话」时被莫名发出）', () => {
    putGuideMail('过期的话', 1_000);
    expect(takeGuideMail(1_000 + GUIDE_MAIL_TTL_MS + 1)).toBeNull();
    expect(getGuideLive().mail).toBeNull();
    putGuideMail('刚好没过期', 1_000);
    expect(takeGuideMail(1_000 + GUIDE_MAIL_TTL_MS)).toBe('刚好没过期');
  });

  it('后放的覆盖先放的（一次只有一句话在等）', () => {
    putGuideMail('第一句');
    putGuideMail('第二句');
    expect(takeGuideMail()).toBe('第二句');
  });
});

describe('⑥ useGuideLive 与重置', () => {
  it('订阅者随登记 / 现场 / 信箱变化而重渲染', () => {
    const { result } = renderHook(() => useGuideLive());
    expect(result.current.kinds).toEqual([]);
    let off = (): void => undefined;
    act(() => {
      off = registerGuideCap('quiz.start', () => undefined);
    });
    expect(result.current.kinds).toEqual(['quiz.start']);
    act(() => setGuideChat({ sessionId: 's', rounds: 3, empty: false, busy: true }));
    expect(result.current.chat?.busy).toBe(true);
    act(() => putGuideMail('来一句'));
    expect(result.current.mail).toBe('来一句');
    act(() => off());
    expect(result.current.kinds).toEqual([]);
  });

  it('resetGuideStore 清空登记 / 现场 / 信箱', () => {
    registerGuideCap('nav.pk', () => undefined);
    setGuideChat({ sessionId: 's', rounds: 1, empty: false, busy: false });
    putGuideMail('x');
    resetGuideStore();
    expect(getGuideLive()).toEqual({ kinds: [], chat: null, mail: null });
    expect(runGuideCap('nav.pk')).toBe(false);
  });
});
