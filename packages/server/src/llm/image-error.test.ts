/**
 * llm/image-error 单测 —— 上游报文翻译器（契约 `docs/IMAGE-GEN-SPEC.md` §6）。
 * 分支按「最具体的排前面」定序；★ 反向锁：遮掉本分支特征后**不得**再判成本分支
 * （vision-error 同款教训——正则里别的东西常绿时，它声称在判的那件事没人验过）。
 */
import { describe, it, expect } from 'vitest';
import { explainImageGenerationFailure, flattenUpstreamBody } from './image-error.js';

describe('flattenUpstreamBody — 压平与截断', () => {
  it('换行缩进压成单空格', () => {
    expect(flattenUpstreamBody('{\n  "error": "x"\n}')).toBe('{ "error": "x" }');
  });
  it('超长截断到 240 并留省略号', () => {
    const long = 'a'.repeat(300);
    const out = flattenUpstreamBody(long);
    expect(out.length).toBe(241); // 240 + …
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('explainImageGenerationFailure — 分支定序', () => {
  it('① 内容策略拒绝：即便包在 400 里也按内容拒绝报', () => {
    const out = explainImageGenerationFailure(400, '{"error":{"code":"content_policy_violation"}}', 'agnes-image-2.5-flash');
    expect(out).toContain('内容安全策略');
    expect(out).toContain('上游原文：');
  });
  it('② 模型不像生图模型：model + 404/400 → 指去设置页换绑', () => {
    const out = explainImageGenerationFailure(404, '{"error":{"message":"The model \'x\' does not exist"}}', 'wrong-model');
    expect(out).toContain('wrong-model');
    expect(out).toContain('角色模型绑定');
  });
  it('③ 401/403 分开报（换 key 与充值是两个下一步）', () => {
    expect(explainImageGenerationFailure(401, 'invalid api key', 'm')).toContain('密钥无效或已过期');
    expect(explainImageGenerationFailure(403, 'permission denied', 'm')).toContain('欠费或未开通');
  });
  it('④ 429 给可执行下一步（等一等），不是改设置', () => {
    const out = explainImageGenerationFailure(429, 'rate limit exceeded', 'm');
    expect(out).toContain('稍等十几秒');
    expect(out).not.toContain('设置');
  });
  it('⑤ 404 且无 model 特征 → 服务商地址问题', () => {
    const out = explainImageGenerationFailure(404, '{"error":"not_found"}', 'm');
    expect(out).toContain('/images/generations');
  });
  it('⑥ 5xx 说「是他们的问题」', () => {
    const out = explainImageGenerationFailure(503, 'upstream overloaded', 'm');
    expect(out).toContain('暂时故障');
    expect(out).toContain('503');
  });
  it('⑦ 兜底不猜病因，但必须带上游原文', () => {
    const out = explainImageGenerationFailure(418, 'I am a teapot', 'm');
    expect(out).toContain('418');
    expect(out).toContain('I am a teapot');
  });
  it('★ 反向锁：无内容拒绝特征的长报文不得误判成内容拒绝', () => {
    // 混入 "moderation" 的邻域词都不给；纯通用 500 报文必须落到 5xx 分支
    const out = explainImageGenerationFailure(500, 'internal server error while rendering', 'm');
    expect(out).not.toContain('内容安全策略');
    expect(out).toContain('暂时故障');
  });
  it('★ 反向锁：非 404/400 的 model 报文不得误判成「模型不像生图模型」', () => {
    const out = explainImageGenerationFailure(429, 'model is rate limited', 'm');
    expect(out).toContain('稍等十几秒');
    expect(out).not.toContain('角色模型绑定');
  });
});
