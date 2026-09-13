/**
 * thinking-status —— 「思考中」等待态文案与计时（纯函数回归）。
 * 文案池轮播节奏（4s/条）与已用时格式化是用户直接看到的体验细节，钉死防回归。
 */
import { describe, expect, it } from 'vitest';
import { formatElapsed, phaseStatus, thinkingPhrase } from './thinking-status';

describe('thinkingPhrase（轮播短语）', () => {
  it('起点与首 4s 显示第一条，不撒谎（此刻什么都还没发生）', () => {
    expect(thinkingPhrase(0)).toBe('正在思考');
    expect(thinkingPhrase(100)).toBe('正在思考');
  });

  it('每 4s 轮换到下一条，循环往复', () => {
    expect(thinkingPhrase(4000)).toBe('正在组织回答');
    expect(thinkingPhrase(8000)).toBe('正在梳理思路');
    // 循环：时长足够长后回到池首（池共 5 条，第 5 个周期绕回）
    expect(thinkingPhrase(4000 * 5)).toBe('正在思考');
  });
});

describe('formatElapsed（已用时）', () => {
  it('一分钟内显示到 0.1s', () => {
    expect(formatElapsed(0)).toBe('0.0s');
    expect(formatElapsed(9400)).toBe('9.4s');
  });

  it('跨分钟换「分秒」口径，秒位补零', () => {
    expect(formatElapsed(61_000)).toBe('1分01秒');
    expect(formatElapsed(125_400)).toBe('2分05秒');
  });
});

describe('phaseStatus（阶段感知，v13）', () => {
  it('有工具在跑就说真话：联网搜索带搜索词', () => {
    expect(
      phaseStatus([{ tool: 'search_web', status: 'running', detail: '什么是闭包' }], 0, 0),
    ).toBe('联网搜索：什么是闭包');
  });

  it('running 无 detail 报「xx中」；done 的步骤不算在跑；取最近一条 running', () => {
    expect(phaseStatus([{ tool: 'tidy_terms', status: 'running' }], 0, 0)).toBe('整理词条库中');
    expect(phaseStatus([{ tool: 'search_web', status: 'done', detail: 'x' }], 0, 0)).toBe('正在思考');
    expect(
      phaseStatus(
        [
          { tool: 'search_web', status: 'done', detail: '旧查询' },
          { tool: 'manage_terms', status: 'running', detail: '记一下闭包' },
        ],
        0,
        0,
      ),
    ).toBe('维护词条库：记一下闭包');
  });

  it('detail 超 24 字截断加省略号（状态行不被长 query 撑爆）', () => {
    const detail = '一'.repeat(30);
    expect(phaseStatus([{ tool: 'search_web', status: 'running', detail }], 0, 0)).toBe(
      `联网搜索：${'一'.repeat(24)}…`,
    );
  });

  it('没工具在跑但思考链在流：深度思考中；全无才回落轮播短语', () => {
    expect(phaseStatus([], 50, 0)).toBe('深度思考中');
    expect(phaseStatus([], 0, 0)).toBe('正在思考');
  });
});
