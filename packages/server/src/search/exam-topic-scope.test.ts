import { describe, expect, it } from 'vitest';
import type { ExamContext } from '../learning/exam-mode.js';
import { quizTopicScope } from './exam-topic-scope.js';
import { directLinksOf } from './exam-direct.js';
import { studyTextOf } from './study-text.js';
import { normalizeForAnchor } from '../learning/collect-quality.js';

const exam: ExamContext = {
  on: true, hosts: ['gaokao.example', 'java.example', 'campus.example', 'custom.example'], summary: '已选三类', signature: 'test',
  sources: [
    { host: 'gaokao.example', label: '高考', packs: ['gaokao'], tier: 'question', note: '' },
    { host: 'java.example', label: '技术', packs: ['tech-interview'], tier: 'question', note: '' },
    { host: 'campus.example', label: '校园资讯', packs: ['campus-info'], tier: 'reference', note: '' },
  ],
};
describe('出题题源与具体主题相交', () => {
  it('高考语法资料先取已选高考题源，校园资讯不冒充题目依据，自定义站保留', () => {
    const focused = quizTopicScope(exam, '高考英语 定语从句');
    expect(focused.hosts).toEqual(['gaokao.example', 'custom.example']);
    expect(focused.sources.map((s) => s.label)).toEqual(['高考']);
    expect(exam.hosts).toHaveLength(4);
  });
  it('Java 与 C++ 都取技术题源，不去其它考试站浪费预算', () => {
    for (const query of ['Java 线程池', 'C++ 智能指针']) expect(quizTopicScope(exam, query).hosts).toEqual(['java.example', 'custom.example']);
  });
  it('用户没有选择该考试的题源时，不能擅自扩大到预置的范围外站点', () => {
    expect(quizTopicScope({ ...exam, hosts: ['java.example'], sources: [exam.sources[1]!] }, '高考英语').hosts).toEqual([]);
  });
  it('显式自填的已登记站也保留，不能按站点的其它类目把用户授权吞掉', () => {
    const focused = quizTopicScope({ ...exam, customHosts: ['java.example', 'custom.example'] }, '高考英语');
    expect(focused.hosts).toEqual(['gaokao.example', 'java.example', 'custom.example']);
    expect(focused.sources.map((s) => s.host)).toContain('java.example');
  });
  it('登记元数据不能独自扩大原范围', () => {
    const focused = quizTopicScope({ ...exam, hosts: ['custom.example'] }, '高考英语');
    expect(focused.hosts).toEqual(['custom.example']);
    expect(focused.sources).toEqual([]);
  });
  it('关闭模式与未识别主题维持原范围', () => {
    const off = { ...exam, on: false };
    expect(quizTopicScope(off, '高考英语')).toBe(off);
    expect(quizTopicScope(exam, '世界历史')).toBe(exam);
  });
  it('站内搜索导航不占六个名额，后面的相关题页能排上来', () => {
    const nav = Array.from({ length: 8 }, (_, i) => `<a href="/exam-nav-${i}">真题大全</a>`).join('');
    const content = Array.from({ length: 8 }, (_, i) => `<a href="/exam-other-${i}">历史试卷</a>`).join('');
    const html = `<nav>${nav}</nav><main>${content}<a href="/exam-clause">英语定语从句专项真题</a></main>`;
    const picks = directLinksOf(html, 'https://gaokao.example/search', ['gaokao.example'], '英语 定语从句');
    expect(picks[0]?.url).toBe('https://gaokao.example/exam-clause');
    expect(picks.some((p) => p.url.includes('nav'))).toBe(false);
    expect(picks).toHaveLength(6);
  });
  it('题干、选项与答案保持可辨识的段落，同时不破坏逐字锚点', () => {
    const text = studyTextOf('<h2>HashMap 是线程安全的吗？</h2><p>不是，多个线程写入会产生竞态。</p><p>应使用 ConcurrentHashMap。</p>');
    expect(text).toContain('HashMap 是线程安全的吗？\n\n不是');
    expect(normalizeForAnchor(text)).toContain(normalizeForAnchor('HashMap 是线程安全的吗？'));
  });
});
