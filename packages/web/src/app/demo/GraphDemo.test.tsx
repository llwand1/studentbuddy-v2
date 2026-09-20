// @vitest-environment jsdom
/**
 * GraphDemo.test — 知识图演示的**渲染层**锁（2026-09-20 知识图演示批）。
 *
 * 与 `graph-demo.test.ts` 的分工：那份锁"第几帧该出现什么"（纯逻辑），
 * 这份锁"显现真的落到 DOM 上了没有"——两件事都可能单独坏：
 * 逻辑对了但组件忘了接 `on` 类，或组件接了但条件渲染把元素**卸载**了（transition 就没了起点）。
 *
 * ★ `vitest.config` 没开 `globals` ⇒ RTL 的自动 cleanup 不会跑，必须显式 `afterEach(cleanup)`，
 *   否则上一个用例的 DOM 会留下来污染 `querySelectorAll` 的计数（本仓既有约定）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { GraphDemo } from './GraphDemo';
import { DEMO_ASK, DEMO_DEEP, DEMO_REPLY_TERMS, FRAME } from './graph-demo';

afterEach(cleanup);

/** 某帧渲染后的容器 */
const at = (stage: number) => render(<GraphDemo stage={stage} />).container;

describe('知识图演示 — 显现落到 DOM', () => {
  it('帧 0：中心 + 一条已确认的边，没有追问按钮', () => {
    const c = at(FRAME.first);
    expect(c.querySelectorAll('.ld-g-n.on').length).toBe(2);
    expect(c.querySelectorAll('.ld-g-e.on').length).toBe(1);
    expect(c.querySelectorAll('.ld-g-ask.on').length).toBe(0);
  });

  it('帧 1：追问按钮亮起，文案与真机词条卡一致', () => {
    const c = at(FRAME.ask);
    expect(c.querySelectorAll('.ld-g-ask.on').length).toBe(1);
    expect(c.querySelector('.ld-g-ask text')?.textContent).toBe(DEMO_ASK.button);
    // 这一帧不加节点（动作还没发生）
    expect(c.querySelectorAll('.ld-g-n.on').length).toBe(2);
  });

  it('帧 2：星型长出（4 个节点 / 4 条边），底部列出逐条抽出的词条', () => {
    const c = at(FRAME.star);
    expect(c.querySelectorAll('.ld-g-n.on').length).toBe(5); // 含中心
    expect(c.querySelectorAll('.ld-g-e.on').length).toBe(4);
    expect(c.querySelectorAll('.ld-g-terms.on').length).toBe(1);
    for (const t of DEMO_REPLY_TERMS) {
      expect([...c.querySelectorAll('.ld-g-term')].map((e) => e.textContent)).toContain(t);
    }
  });

  it('帧 3：树长成（7 个节点 / 6 条边），清单换成二跳抽出的词条', () => {
    const c = at(FRAME.tree);
    expect(c.querySelectorAll('.ld-g-n.on').length).toBe(7);
    expect(c.querySelectorAll('.ld-g-e.on').length).toBe(6);
    const texts = [...c.querySelectorAll('.ld-g-term')].map((e) => e.textContent);
    expect(texts).toEqual([...DEMO_DEEP.terms]);
    expect(c.querySelector('.ld-g-terms-label')?.textContent).toContain(DEMO_DEEP.term);
  });

  it('★ 未显现的节点**仍在 DOM 里**（只是 opacity 0）——卸载会让"长出来"变成"啪地弹出"', () => {
    const c = at(FRAME.first);
    // 最终拓扑 7 个节点（含中心）全部渲染，只有 2 个带 on
    expect(c.querySelectorAll('.ld-g-n').length).toBe(7);
    expect(c.querySelectorAll('.ld-g-e').length).toBe(6);
  });
});

describe('知识图演示 — 末帧的出处分层', () => {
  it('确认转正后实线从 1 条变 2 条（虚线"收拢"成实线是本演示的落点）', () => {
    expect(at(FRAME.tree).querySelectorAll('.ld-g-e.user').length).toBe(1);
    expect(at(FRAME.origin).querySelectorAll('.ld-g-e.user').length).toBe(2);
  });

  it('图例在末帧亮起，且**只有图上真实存在的两种**（不列图上看不到的 derived）', () => {
    const c = at(FRAME.origin);
    expect(c.querySelectorAll('.ld-g-legend.on').length).toBe(1);
    const items = [...c.querySelectorAll('.ld-g-legend .gr-legend-item')];
    expect(items.length).toBe(2);
    expect(items.map((e) => e.className).some((k) => k.includes('user'))).toBe(true);
    expect(items.map((e) => e.className).some((k) => k.includes('ai'))).toBe(true);
    // 「未经确认」这个关键限定词必须在（否则用户以为 AI 连的边是可信的）
    expect(items.map((e) => e.textContent).join('')).toContain('未经确认');
  });

  it('末帧的抽词清单让位给图例（两者共用同一格，不叠着挤）', () => {
    const c = at(FRAME.origin);
    expect(c.querySelectorAll('.ld-g-terms.on').length).toBe(0);
  });
});
