import { describe, expect, it } from 'vitest';
import { normalizeCampfireQuestion, openerChatPrompt, parseOpenerRequest } from './campfire-opener.js';

const q = { topic: '概率', question: '公平硬币下一次为正面的概率？', options: ['25%', '50%', '75%'], answer: 1, explanation: '每次独立，正面的概率是 50%。' };
describe('开场题交付契约', () => {
  it('真实复杂矩阵错题不作为热身交付，概念判断与单行向量仍允许，选项不叠标签', () => {
    expect(normalizeCampfireQuestion({ ...q, question: 'A = [1 2 3 6; 2 4 5 10; 3 6 4 12] 的秩？' })).toBeNull();
    expect(normalizeCampfireQuestion({ ...q, explanation: '取 A=diag(1,-1)，则 A 加 A 的逆矩阵为 diag(2,0)。' })).toBeNull();
    expect(normalizeCampfireQuestion({ ...q, question: '矩阵的秩是否等于线性无关列向量的最大个数？' })).not.toBeNull();
    expect(normalizeCampfireQuestion({ ...q, question: '向量 [1, 2, 3] 有几个分量？' })).not.toBeNull();
    expect(normalizeCampfireQuestion({ ...q, options: ['A: 25%', 'B: 50%', 'C: 75%'] })).toBeNull();
  });
  it.each([
    ['越界答案', { ...q, answer: 3 }], ['小数答案', { ...q, answer: .5 }],
    ['重复选项', { ...q, options: ['50%', '５０％'] }], ['缺外部图', { ...q, question: '根据下图，正面的概率是多少？' }],
    ['缺解析', { ...q, explanation: '' }], ['选项过多', { ...q, options: ['1', '2', '3', '4', '5'] }],
  ])('%s 不交付给学习者', (_label, value) => expect(normalizeCampfireQuestion(value)).toBeNull());
  it('不同标点与空白不能绕过近期题排重', () => {
    expect(normalizeCampfireQuestion(q, ['公平硬币 下一次为正面的概率？'])).toBeNull();
  });
  it('卷轴拒绝各字段的代码围栏，但保留纯文字代码表达式', () => {
    for (const field of ['topic', 'question', 'explanation']) {
      expect(normalizeCampfireQuestion({ ...q, [field]: '```python\nlen([1, 2])\n```' })).toBeNull();
    }
    expect(normalizeCampfireQuestion({ ...q, options: ['~~~python\nlen([1, 2])\n~~~', '50%'] })).toBeNull();
    expect(normalizeCampfireQuestion({ ...q, question: 'Python 中 len([1, 2]) 的返回值是多少？' })).not.toBeNull();
  });
  it('带题开聊不依赖上一段会话，保留题目、选项与用户选择', () => {
    const prompt = openerChatPrompt(q, 0);
    expect(prompt).toContain(q.question);
    expect(prompt).toContain('B. 50%');
    expect(prompt).toContain('我选了 A');
    expect(prompt).toContain(q.explanation);
  });
  it('排重输入有界，非法请求不进入模型', () => {
    expect(parseOpenerRequest({ exclude: Array(9).fill('旧题') })).toBeNull();
    expect(parseOpenerRequest({ exclude: ['x'.repeat(401)] })).toBeNull();
    expect(parseOpenerRequest({ exclude: [2] })).toBeNull();
  });
});
