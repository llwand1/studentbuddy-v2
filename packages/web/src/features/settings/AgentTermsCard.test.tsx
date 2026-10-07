// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentTermsCard } from './AgentTermsCard';
const h = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), revoke: vi.fn(), copy: vi.fn() }));
vi.mock('../../lib/api-agent-terms', () => ({ agentKeysApi: h }));
const key = { id: 'key-1', name: '研究 agent', prefix: 'sb_terms_prefix', createdAt: Date.now(), expiresAt: Date.now() + 86400000, lastUsedAt: null, revokedAt: null };
beforeEach(() => {
  vi.clearAllMocks(); h.list.mockResolvedValue({ keys: [] }); h.create.mockResolvedValue({ key, token: 'only-this-response' });
  h.revoke.mockResolvedValue({ ok: true }); h.copy.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: h.copy } });
});
afterEach(cleanup);
describe('外部 agent 词条补给设置卡', () => {
  it('完成初始读取才可生成，明文只在本次 password 输入框，说明复制不包含密钥', async () => {
    let done: (r: { keys: [] }) => void = () => {};
    h.list.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    render(<AgentTermsCard flash={vi.fn()} />);
    expect((screen.getByRole('button', { name: '生成专用密钥' }) as HTMLButtonElement).disabled).toBe(true);
    done({ keys: [] });
    await waitFor(() => expect((screen.getByRole('button', { name: '生成专用密钥' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('密钥名称'), { target: { value: '研究 agent' } });
    fireEvent.click(screen.getByRole('button', { name: '生成专用密钥' }));
    const secret = await screen.findByLabelText('新密钥') as HTMLInputElement;
    expect(secret.type).toBe('password'); expect(secret.value).toBe('only-this-response');
    fireEvent.click(screen.getByRole('button', { name: '复制 agent 使用说明' }));
    await waitFor(() => expect(h.copy).toHaveBeenCalled());
    expect(h.copy.mock.calls[0]?.[0]).toContain('STUDENTBUDDY_TERMS_TOKEN');
    expect(h.copy.mock.calls[0]?.[0]).not.toContain('only-this-response');
    fireEvent.click(screen.getByRole('button', { name: '复制密钥' }));
    await waitFor(() => expect(h.copy).toHaveBeenCalledWith('only-this-response'));
  });
  it('撤销立即清除本次密钥并显示失效状态，刷新后的列表不能恢复明文', async () => {
    const flash = vi.fn(); const { unmount } = render(<AgentTermsCard flash={flash} />);
    await waitFor(() => expect((screen.getByRole('button', { name: '生成专用密钥' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '生成专用密钥' }));
    await screen.findByLabelText('新密钥');
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await screen.findByText('已撤销'); expect(screen.queryByLabelText('新密钥')).toBeNull();
    expect(h.revoke).toHaveBeenCalledWith('key-1');
    unmount(); h.list.mockResolvedValue({ keys: [{ ...key, revokedAt: Date.now() }] });
    render(<AgentTermsCard flash={flash} />); await screen.findByText('已撤销'); expect(screen.queryByLabelText('新密钥')).toBeNull();
  });
  it('列表与创建错误可见，失败不伪装成已有凭证', async () => {
    h.list.mockRejectedValue(new Error('列表读取失败')); h.create.mockRejectedValue(new Error('有效密钥已满'));
    render(<AgentTermsCard flash={vi.fn()} />); await screen.findByText('列表读取失败');
    await waitFor(() => expect((screen.getByRole('button', { name: '生成专用密钥' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '生成专用密钥' }));
    await screen.findByText('有效密钥已满'); expect(screen.queryByLabelText('新密钥')).toBeNull();
  });
});
