/**
 * chat/vision-error.test — 「看图失败」报文翻译器的单测（纯函数，零网络零 DB）。
 *
 * 为什么值得测：2026-09-20 老板发图被上游 400 挡下，屏幕上是一串英文 JSON
 * （`{"error":{"message":"模型 agnes-image-2.5-flash 是 image 模型，请使用 /v1/images/generations"}}`），
 * 他的原话是「我使用视觉模型它提示 400」——**报错没有给出任何可执行动作**，
 * 只能靠人肉去读库、猜绑定、打上游。ADR-5 要求失败可读可重试，本文件把每条判据钉住。
 *
 * ★ 用例里的报文**全是真机回包原样**（除截断演示），不是编出来的字符串。
 */
import { describe, it, expect } from 'vitest';
import { explainVisionFailure } from './vision-error.js';

/** 2026-09-20 真机回包（provider=agnes, vision 角色误绑 agnes-image-2.5-flash） */
const REAL_400 =
  'OpenAI API error 400: {"error":{"code":"invalid_request","message":"模型 agnes-image-2.5-flash 是 image 模型，请使用 /v1/images/generations (request id: 20260920130530828944270XgqgksQr)","type":"AgnesAI_error"}}';

/** 取「上游原文：」之后的那段；没有就抛错（本仓禁 `!` 非空断言，存在性要写成会红的断言） */
function afterUpstreamMarker(out: string): string {
  const i = out.indexOf('上游原文：');
  if (i < 0) throw new Error(`文案里丢了上游原文：${out}`);
  return out.slice(i + '上游原文：'.length);
}

describe('explainVisionFailure：误绑"生成图片"的模型', () => {
  it('真机那条 400 被翻成「去设置页改绑」的可执行指引', () => {
    const out = explainVisionFailure(new Error(REAL_400), 'agnes-image-2.5-flash');
    expect(out).toContain('只会**生成图片**，不会**读图片**');
    expect(out).toContain('「视觉（看图）」');
    // 模型名必须出现在文案里：设置页里十几个模型，不点名等于没说
    expect(out).toContain('agnes-image-2.5-flash');
  });

  it('原文仍附在末行备查（翻译不能吞掉证据）', () => {
    const out = explainVisionFailure(new Error(REAL_400), 'agnes-image-2.5-flash');
    expect(out).toContain('上游原文：');
    expect(out).toContain('AgnesAI_error');
  });

  it('英文服务商的同类报文（/v1/images/generations）走同一分支', () => {
    const out = explainVisionFailure(
      new Error('OpenAI API error 400: {"error":{"message":"This is an image generation model, please use /v1/images/generations"}}'),
      'some-image-model',
    );
    expect(out).toContain('只会**生成图片**');
  });
});

describe('explainVisionFailure：其它病因各归各位', () => {
  it('纯文本模型被绑给视觉角色 → 说"不接受图片输入"并给候选型号', () => {
    const out = explainVisionFailure(
      new Error('OpenAI API error 400: {"error":{"message":"The model deepseek-chat does not support image input"}}'),
      'deepseek-chat',
    );
    expect(out).toContain('不接受图片输入');
    expect(out).toContain('qwen-vl-plus');
    expect(out).not.toContain('只会**生成图片**');
  });

  it('404 模型不存在 → 指向"重新选择视觉模型"，不误导成密钥问题', () => {
    const out = explainVisionFailure(new Error('OpenAI API error 404: {"error":{"message":"The model `glm-4v-x` does not exist"}}'), 'glm-4v-x');
    expect(out).toContain('没有这个模型');
    expect(out).not.toContain('API Key');
  });

  it('401 密钥失效（Anthropic 前缀也要认）→ 指向密钥与余额', () => {
    const out = explainVisionFailure(new Error('Anthropic API error 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), 'claude-3-5-sonnet');
    expect(out).toContain('拒绝了这把密钥');
  });

  it('429 限流 → 要的是"稍等再试"，不是"去改设置"', () => {
    const out = explainVisionFailure(new Error('OpenAI API error 429: {"error":{"message":"Rate limit reached for free tier quota"}}'), 'agnes-2.5-flash');
    expect(out).toContain('稍等十几秒再发一次');
  });

  it('5xx → 明说不是本地配置问题（否则老板会去翻设置页白折腾）', () => {
    const out = explainVisionFailure(new Error('OpenAI API error 502: <html>Bad Gateway</html>'), 'agnes-2.5-flash');
    expect(out).toContain('不是本地配置问题');
  });

  it('超时 → 给出"图片越大越慢"的因果', () => {
    const out = explainVisionFailure(new Error('上游 180s 无任何响应（超时）'), 'agnes-3.0-flash');
    expect(out).toContain('响应超时');
  });
});

describe('explainVisionFailure：判据本身', () => {
  it('★ 反向锁：抹掉"是 image 模型"字样后，同一条 400 不再被判成生成模型', () => {
    // 证明分支靠**报文里的字样**，不靠"看见 400 就说是生成模型"这种瞎猜。
    // 若实现改成按状态码归类，这条会立刻红。
    const masked = REAL_400.replace('是 image 模型，请使用 /v1/images/generations', 'something is wrong');
    const out = explainVisionFailure(new Error(masked), 'agnes-image-2.5-flash');
    expect(out).not.toContain('只会**生成图片**');
    expect(out).toContain('看图失败');
  });

  it('认不出的报文不猜病因：只说谁在失败 + 附原文', () => {
    const out = explainVisionFailure(new Error('OpenAI API error 400: {"error":{"message":"something exotic"}}'), 'mystery-model');
    expect(out).toBe('看图失败（视觉模型 `mystery-model`）：上游原文：OpenAI API error 400: {"error":{"message":"something exotic"}}');
  });

  it('超长原文压到 240 字并加省略号（错误框不能被一张报文撑爆）', () => {
    const out = explainVisionFailure(new Error(`OpenAI API error 400: ${'x'.repeat(3000)}`), 'm');
    const raw = afterUpstreamMarker(out);
    expect(raw.length).toBeLessThanOrEqual(241);
    expect(raw.endsWith('…')).toBe(true);
  });

  it('非 Error 的脏值（字符串/undefined）也要出文案，不能抛第二次异常', () => {
    expect(explainVisionFailure('boom', 'm')).toContain('看图失败');
    expect(explainVisionFailure(undefined, 'm')).toContain('上游原文：undefined');
  });

  it('模型名为空时写「未绑定」而不是留个空括号', () => {
    expect(explainVisionFailure(new Error('boom'), '')).toContain('`未绑定`');
  });
});
