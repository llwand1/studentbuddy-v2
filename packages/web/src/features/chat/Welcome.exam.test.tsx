// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { request: h.request } }));
vi.mock('../exam/useExamScope', () => ({ useExamScope: () => ({ on: true, summary: '考研', loaded: true }) }));
const { Welcome } = await import('./Welcome');
afterEach(cleanup);
describe('开场题 × 应试范围', () => {
  it('等待时呈现当前范围，直接提问不必等召题，也不显示固定建议卡', () => {
    const { container } = render(<Welcome onPick={vi.fn()} onAsk={vi.fn()} />);
    expect(screen.getByText('在考研范围内，先热个身。')).toBeTruthy();
    expect(container.querySelector('.welcome-card')).toBeNull();
    expect(screen.getByRole('button', { name: /我有自己的问题/ })).toBeTruthy();
    expect(container.querySelector('.opener-option')).toBeNull();
  });
});
