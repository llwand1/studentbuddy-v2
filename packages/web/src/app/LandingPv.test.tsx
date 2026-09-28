// @vitest-environment jsdom
/**
 * LandingPv.test — 落地页「看 PV」入口与弹层播放的锁（2026-09-28）。
 *
 * ★ 按「坏了最没人发现」排序，只守五条性质：
 *   ① **不点就不下载**：弹层关着时页面里没有 `<video>`。片子二十多兆，这条一破，
 *      每个访客的首屏都会多背那笔流量，而**没有任何东西会报错**；
 *   ② 关得掉、且是**卸载**不是隐藏：Esc／遮罩／关闭键三条路都能关，关掉后节点消失
 *      （只 hide 不卸载＝视频还在后台跑）；
 *   ③ 层内点击不误关：遮罩关闭靠的是事件冒泡，`stopPropagation` 一漏，点播放控件都会关窗；
 *   ④ 背景滚动锁与解锁成对：关掉后 `body` 的 overflow 必须回到打开前的样子；
 *   ⑤ 两语都上屏：切到英文后按钮与弹层文案是英文（漏接 `[lang]` 只会静默留中文）。
 *   ★ 另用一条断言锁住「弹层直挂 `document.body`」：jsdom 里看不见几何，但这条是那次真机
 *     事故（页眉 `backdrop-filter` 给 `fixed` 造包含块 ⇒ 遮罩只盖住顶栏）的**唯一可锁抓手**，
 *     丢了它就只剩真机才能发现。
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { LANDING_LANG_KEY, LandingLangProvider } from './landing-lang';
import { LandingPv, PV_SRC } from './LandingPv';
import { PV } from './landing-copy';

const setup = (lang: 'zh' | 'en' = 'zh') => {
  window.localStorage.setItem(LANDING_LANG_KEY, lang);
  return render(
    <LandingLangProvider>
      <LandingPv />
    </LandingLangProvider>,
  );
};

/** 弹层挂在 `document.body` 上（不是 render 容器里），所以一律从 body 找。 */
const inBody = <T extends Element>(sel: string) => document.body.querySelector(sel) as T | null;

const openBox = () => fireEvent.click(screen.getByRole('button', { name: PV.open.zh }));

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.body.style.overflow = '';
});

describe('落地页 · 看 PV', () => {
  it('① 弹层关着时页面上没有 <video>（不点就不下载）', () => {
    setup();
    expect(document.body.querySelector('video')).toBeNull();
  });

  it('② 点开后出现 dialog，视频指向站点静态路径且带播放控件', () => {
    setup();
    openBox();
    expect(screen.getByRole('dialog', { name: PV.title.zh })).toBeTruthy();
    // 直挂 body：留在页眉里会被 backdrop-filter 的包含块吃掉（真机实测遮罩只剩顶栏那一条）
    expect(inBody('.landing-pv-mask')?.parentElement).toBe(document.body);
    const video = inBody<HTMLVideoElement>('video');
    expect(video?.getAttribute('src')).toBe(PV_SRC);
    expect(video?.controls).toBe(true);
  });

  it('③ Esc 关闭后 <video> 真的从 DOM 卸载（不是藏起来）', () => {
    setup();
    openBox();
    expect(inBody('video')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.querySelector('video')).toBeNull();
  });

  it('④ 关闭键与遮罩都能关；点层内不误关（遮罩靠冒泡，stopPropagation 一漏就出事）', () => {
    setup();
    openBox();
    // 点层内（视频本体）：必须还在
    fireEvent.click(inBody('video') as Element);
    expect(screen.queryByRole('dialog')).toBeTruthy();
    // 点关闭键：关
    fireEvent.click(screen.getByRole('button', { name: PV.close.zh }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // 再开一次，点遮罩：关
    openBox();
    fireEvent.click(inBody('.landing-pv-mask') as Element);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('⑤ 背景滚动锁与解锁成对（关掉后回到打开前的样子）', () => {
    setup();
    expect(document.body.style.overflow).toBe('');
    openBox();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('');
  });

  it('⑥ 英文侧按钮与弹层文案都是英文，且不与中文同形', () => {
    setup('en');
    expect(PV.open.en).not.toBe(PV.open.zh);
    fireEvent.click(screen.getByRole('button', { name: PV.open.en }));
    expect(screen.getByRole('dialog', { name: PV.title.en })).toBeTruthy();
    expect(screen.getByRole('button', { name: PV.close.en })).toBeTruthy();
    for (const s of [PV.open.en, PV.title.en, PV.close.en]) {
      expect(s, `en 侧漏了中文：${s}`).not.toMatch(/[\u4e00-\u9fa5]/);
    }
  });
});