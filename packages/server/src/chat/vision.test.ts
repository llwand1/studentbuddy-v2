/**
 * chat/vision.test — 「文本模型读图」蒸馏层的单测（无真实 API、无 DB）。
 *
 * 为什么值得测：FrameWise 全仓 0 测试，这是它最该被超越的地方。本测试用假适配器
 * 验证两件事——① 图被发给视觉模型并蒸馏成文字描述；② 未配置视觉角色时抛**清晰可读**
 * 的错误（而不是笼统的「模型不可用」），这正是 ADR-5「报错说真话」的落地。
 */
import { describe, it, expect, vi } from 'vitest';
import type { LLMAdapter } from '../llm/types.js';
import { describeImages, parseIncomingImages } from './vision.js';

const fakeAdapter: LLMAdapter = {
  type: 'openai',
  async *chat() {
    yield { content: '图里是一个开口向上的二次函数 y = x²，顶点在原点。', done: false };
    yield { content: '', done: true };
  },
  async listModels() {
    return [];
  },
};

// 把 llm/router 整个替掉：只暴露 routeRole，避免加载 db / crypto 等真实依赖
vi.mock('../llm/router.js', () => ({
  routeRole: vi.fn((role: string) => {
    if (role === 'vision') {
      return {
        adapter: fakeAdapter,
        model: 'vl-model',
        apiKey: 'k',
        baseUrl: 'http://x/v1',
        streamMode: 'once' as const,
      };
    }
    return null;
  }),
}));

describe('describeImages', () => {
  it('把图片蒸馏成中文描述', async () => {
    const desc = await describeImages([{ dataUrl: 'data:image/png;base64,AAAA' }]);
    expect(desc).toContain('二次函数');
  });

  it('多图也只产出一段描述', async () => {
    const desc = await describeImages([
      { dataUrl: 'data:image/png;base64,AAAA' },
      { dataUrl: 'data:image/png;base64,BBBB' },
    ]);
    expect(typeof desc).toBe('string');
    expect(desc.length).toBeGreaterThan(0);
  });

  it('空图返回空串（不调视觉模型）', async () => {
    expect(await describeImages([])).toBe('');
  });

  it('未配置视觉角色时抛清晰错误', async () => {
    // 让 routeRole 对 vision 返回 null
    const { routeRole } = await import('../llm/router.js');
    vi.mocked(routeRole).mockImplementationOnce(() => null);
    await expect(describeImages([{ dataUrl: 'data:image/png;base64,AAAA' }])).rejects.toThrow(
      /未配置视觉模型/,
    );
  });

  it('绑定了 provider 但没填模型名时同样报错（空 model 会让视觉调用 400）', async () => {
    const { routeRole } = await import('../llm/router.js');
    vi.mocked(routeRole).mockImplementationOnce(
      () =>
        ({
          adapter: fakeAdapter,
          model: '',
          apiKey: 'k',
          baseUrl: 'http://x/v1',
          streamMode: 'once',
        }) as unknown as ReturnType<typeof routeRole>,
    );
    await expect(describeImages([{ dataUrl: 'data:image/png;base64,AAAA' }])).rejects.toThrow(
      /未配置视觉模型/,
    );
  });
});

describe('parseIncomingImages（HTTP 边界校验）', () => {
  const png = 'data:image/png;base64,AAAA';

  it('无图 / 空数组都返回空列表', () => {
    expect(parseIncomingImages(undefined)).toEqual({ ok: true, images: [] });
    expect(parseIncomingImages([])).toEqual({ ok: true, images: [] });
  });

  it('保留合法图片与文件名', () => {
    const r = parseIncomingImages([{ dataUrl: png, name: 'a.png' }]);
    expect(r).toEqual({ ok: true, images: [{ dataUrl: png, name: 'a.png' }] });
  });

  it('丢弃非图片 dataURL 与脏值（不透传给视觉模型）', () => {
    const r = parseIncomingImages([
      { dataUrl: 'data:text/plain;base64,zzz' },
      { dataUrl: 'http://evil/x.png' },
      null,
      { dataUrl: 123 },
      { dataUrl: png },
    ]);
    expect(r).toEqual({ ok: true, images: [{ dataUrl: png }] });
  });

  it('超 4 张拒绝', () => {
    const many = Array.from({ length: 5 }, () => ({ dataUrl: png }));
    const r = parseIncomingImages(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/最多上传 4 张/);
  });

  it('单张超限拒绝（拦在路由层，别让它打爆视觉模型）', () => {
    const r = parseIncomingImages([{ dataUrl: `data:image/png;base64,${'A'.repeat(7_000_001)}` }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/过大/);
  });
});
