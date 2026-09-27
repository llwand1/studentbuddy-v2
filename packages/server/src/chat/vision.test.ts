/**
 * chat/vision.test — 「文本模型读图」蒸馏层的单测（无真实 API、无 DB）。
 *
 * 为什么值得测：FrameWise 全仓 0 测试，这是它最该被超越的地方。本测试用假适配器
 * 验证两件事——① 图被发给视觉模型并蒸馏成文字描述；② 未配置视觉角色时抛**清晰可读**
 * 的错误（而不是笼统的「模型不可用」），这正是 ADR-5「报错说真话」的落地。
 */
import { describe, it, expect, vi } from 'vitest';
import { MAX_CHAT_IMAGES, MAX_IMAGE_DATAURL_CHARS } from '@sb/shared';
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

/** 一个"吐一帧空内容后按上游口径报错"的适配器：用来喂真机报文，验证错误翻译确实挂在链路上 */
function throwingAdapter(message: string): LLMAdapter {
  return {
    type: 'openai',
    async *chat() {
      yield { content: '', done: false };
      throw new Error(message);
    },
    async listModels() {
      return [];
    },
  };
}

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

  // ★ 接线锁（2026-09-20）：真机那次「提示 400」的报文是**上游英文 JSON**，用户看不懂也不知道改哪里。
  //   只测 `vision-error.ts` 纯函数证明不了"它真的被挂上了"，所以这里用假适配器把**原样报文**喂进
  //   `describeImages`，断言抛出的是中文指引 —— 摘掉 vision.ts 里的 try/catch 这两条立刻红。
  it('上游把"生成图片的模型"当视觉模型用时：抛中文指引而不是裸 400 报文', async () => {
    const { routeRole } = await import('../llm/router.js');
    vi.mocked(routeRole).mockImplementationOnce(
      () =>
        ({
          adapter: throwingAdapter(
            'OpenAI API error 400: {"error":{"code":"invalid_request","message":"模型 agnes-image-2.5-flash 是 image 模型，请使用 /v1/images/generations (request id: 20260920130530828944270XgqgksQr)","type":"AgnesAI_error"}}',
          ),
          model: 'agnes-image-2.5-flash',
          apiKey: 'k',
          baseUrl: 'http://x/v1',
          streamMode: 'once',
        }) as unknown as ReturnType<typeof routeRole>,
    );
    await expect(describeImages([{ dataUrl: 'data:image/png;base64,AAAA' }])).rejects.toThrow(
      /只会\*\*生成图片\*\*，不会\*\*读图片\*\*.*「视觉（看图）」/s,
    );
  });

  it('视觉模型限流时：抛「稍等再试」，不误报成配置错', async () => {
    const { routeRole } = await import('../llm/router.js');
    vi.mocked(routeRole).mockImplementationOnce(
      () =>
        ({
          adapter: throwingAdapter('OpenAI API error 429: {"error":{"message":"Rate limit reached"}}'),
          model: 'agnes-2.5-flash',
          apiKey: 'k',
          baseUrl: 'http://x/v1',
          streamMode: 'once',
        }) as unknown as ReturnType<typeof routeRole>,
    );
    const p = describeImages([{ dataUrl: 'data:image/png;base64,AAAA' }]);
    await expect(p).rejects.toThrow(/服务商限流/);
    await expect(p).rejects.not.toThrow(/只会\*\*生成图片/);
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

  it(`超 ${MAX_CHAT_IMAGES} 张拒绝`, () => {
    const many = Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => ({ dataUrl: png }));
    const r = parseIncomingImages(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(new RegExp(`最多上传 ${MAX_CHAT_IMAGES} 张`));
  });

  it('单张超限拒绝（拦在路由层，别让它打爆视觉模型）', () => {
    // ★ 边界从 `@sb/shared` 的常量取，不写死数字：写死的话调了限额这条锁就悄悄失去意义
    //   （旧版写的是 7_000_001，与当时的 MAX_DATAURL_CHARS 巧合同步；上限改成 500 万后
    //   它仍然「碰巧」会过——但那已经不是它声称在测的那个边界了）
    const over = 'A'.repeat(MAX_IMAGE_DATAURL_CHARS + 1);
    const r = parseIncomingImages([{ dataUrl: `data:image/png;base64,${over}` }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/过大/);
  });
});
