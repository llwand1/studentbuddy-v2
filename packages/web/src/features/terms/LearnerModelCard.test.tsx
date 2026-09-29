// @vitest-environment jsdom
/**
 * LearnerModelCard — 学习画像：四类信息的呈现、空模型不渲染、「我懂了」解决误区、校准的人话。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ model: vi.fn(), resolveMisconception: vi.fn() }));
vi.mock('../../lib/api-ai-ops', () => ({ aiOpsApi: api }));
const { LearnerModelCard, calibrationText, personalText, qtypeLabel } = await import('./LearnerModelCard');
const { stabilityText } = await import('./ReviewPanel');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const MODEL = {
  weakTerms: [{ id: 't1', term: '卡尔文循环', retention: 0.42, difficulty: 7 }],
  misconceptions: [{ id: 'm1', termId: 't1', topic: '卡尔文循环', note: '以为只在夜里进行', count: 2, lastSeen: '' }],
  byType: [{ qtype: 'fill', answers: 4, correct: 1 }],
  calibration: { n: 20, predicted: 0.88, actual: 0.7 },
  ability: { theta: 1.8, n: 30, recentAccuracy: 0.9, targetB: 0.56, level: '进阶' },
  fsrs: { scale: 1.4, n: 64, fittedAt: '2026-09-29 10:00:00', lossDefault: 0.5, lossFitted: 0.4 },
};

describe('LearnerModelCard', () => {
  it('快忘词条、误区（含次数）、题型正确率、校准都上屏', async () => {
    api.model.mockResolvedValue(MODEL);
    render(<LearnerModelCard refreshKey={0} />);
    expect(await screen.findByText('卡尔文循环 42%')).toBeTruthy();
    expect(screen.getByText('以为只在夜里进行')).toBeTruthy();
    expect(screen.getByText('×2')).toBeTruthy();
    expect(screen.getByText('填空 1/4')).toBeTruthy();
    expect(screen.getByText(/预测记住 88%，实际 70%/)).toBeTruthy();
    expect(screen.getByText(/建议「进阶」档/)).toBeTruthy();
    expect(screen.getByText(/按你的 64 次复习个人化：你记得比默认模型以为的牢，复习间隔拉长约 40%/)).toBeTruthy();
  });

  it('★「我懂了」⇒ 调接口并从列表移除', async () => {
    api.model.mockResolvedValue(MODEL);
    api.resolveMisconception.mockResolvedValue({ ok: true });
    render(<LearnerModelCard refreshKey={0} />);
    fireEvent.click(await screen.findByRole('button', { name: '我懂了' }));
    await waitFor(() => expect(screen.queryByText('以为只在夜里进行')).toBeNull());
    expect(api.resolveMisconception).toHaveBeenCalledWith('m1');
  });

  it('★ 空模型或拉取失败 ⇒ 整卡不渲染', async () => {
    api.model.mockResolvedValue({ weakTerms: [], misconceptions: [], byType: [], calibration: null, ability: { theta: 0, n: 2, recentAccuracy: 1, targetB: null, level: null }, fsrs: null });
    const { container } = render(<LearnerModelCard refreshKey={0} />);
    await waitFor(() => expect(api.model).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('refreshKey 变了才重拉', async () => {
    api.model.mockResolvedValue(MODEL);
    const { rerender } = render(<LearnerModelCard refreshKey={1} />);
    rerender(<LearnerModelCard refreshKey={1} />);
    rerender(<LearnerModelCard refreshKey={2} />);
    await waitFor(() => expect(api.model).toHaveBeenCalledTimes(2));
  });
});

describe('文案', () => {
  it('校准三种结论', () => {
    expect(calibrationText({ n: 10, predicted: 0.9, actual: 0.7 })).toContain('间隔对你偏长');
    expect(calibrationText({ n: 10, predicted: 0.7, actual: 0.9 })).toContain('偏保守');
    expect(calibrationText({ n: 10, predicted: 0.85, actual: 0.8 })).toContain('排期可信');
  });
  it('稳定性人话与题型名', () => {
    expect([0.5, 12.4, 90, 800].map(stabilityText)).toEqual(['不到 1 天', '12 天', '3 个月', '2 年']);
    expect(qtypeLabel('short')).toBe('解答');
    expect(qtypeLabel('x')).toBe('x');
  });
});

describe('personalText', () => {
  const p = (scale: number) => ({ scale, n: 40, fittedAt: '', lossDefault: 0.5, lossFitted: 0.45 });
  it('三种结论', () => {
    expect(personalText(p(1.02))).toContain('基本一致');
    expect(personalText(p(0.7))).toContain('缩短约 30%');
    expect(personalText(p(2))).toContain('拉长约 100%');
  });
});
