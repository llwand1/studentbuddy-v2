import { describe, expect, it } from 'vitest';
import { validateAgentTermBatch, agentTermsInstructions } from './agent-terms.js';
const term = { term: ' RAG ', definition: ' 检索增强生成 ', domain: ' LLM ' };
describe('外部 agent 词条契约', () => {
  it('兼容桌面评审台导出，来源站名仅作为注记，默认加入复习', () => {
    const r = validateAgentTermBatch({ batchId: 'desktop-1', terms: [{ ...term, source_host: '学习者自选（不经网页）', freq: 3 }] });
    expect(r.ok && r.value).toMatchObject({ review: true, terms: [{ term: 'RAG', domain: 'llm', sourceUrls: [], sourceNote: '学习者自选（不经网页）' }] });
  });
  it('坏条目定位下标，不截短定义或过滤坏条目', () => {
    expect(validateAgentTermBatch({ batchId: 'a', terms: [term, { ...term, definition: 'x'.repeat(4001) }] })).toMatchObject({ ok: false, index: 1 });
    expect(validateAgentTermBatch({ batchId: 'a', terms: [{ ...term, domain: 'x'.repeat(31) }] }).ok).toBe(false);
  });
  it('拒绝越权字段与非布尔 review，不能指定 owner 或会话', () => {
    expect(validateAgentTermBatch({ batchId: 'a', owner_id: 'u-b', terms: [term] }).ok).toBe(false);
    expect(validateAgentTermBatch({ batchId: 'a', terms: [{ ...term, sourceSessionId: 's-b' }] }).ok).toBe(false);
    expect(validateAgentTermBatch({ batchId: 'a', review: 'yes', terms: [term] }).ok).toBe(false);
  });
  it('来源只接收真实形状的无凭证 http(s) URL，归一去重', () => {
    for (const url of ['javascript:alert(1)', 'https://name:secret@example.com/a', 'not-url']) expect(validateAgentTermBatch({ batchId: 'a', terms: [{ ...term, sourceUrls: [url] }] }).ok).toBe(false);
    const r = validateAgentTermBatch({ batchId: 'a', terms: [{ ...term, sourceUrls: ['https://example.com', 'https://example.com/'] }] });
    expect(r.ok && r.value.terms[0]?.sourceUrls).toEqual(['https://example.com/']);
  });
  it('批次与集合有界，null 集合不能静默当空数组', () => {
    for (const terms of [[], Array(101).fill(term)]) expect(validateAgentTermBatch({ batchId: 'a', terms }).ok).toBe(false);
    expect(validateAgentTermBatch({ batchId: '../bad', terms: [term] }).ok).toBe(false);
    expect(validateAgentTermBatch({ batchId: 'a', terms: [{ ...term, aliases: null }] }).ok).toBe(false);
  });
  it('可复制说明指向当前站点并要求私有环境变量，不包含任何密钥', () => {
    const text = agentTermsInstructions('https://example.com');
    expect(text).toContain('https://example.com/api/open/v1/context'.replace('/context', ''));
    expect(text).toContain('STUDENTBUDDY_TERMS_TOKEN'); expect(text).toContain('visibleInCurrentScope=false');
    expect(text).not.toContain('sb_terms_');
  });
});
