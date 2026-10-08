/**
 * chat/system-prompt —— 系统提示词本身的回归锁（2026-09-24 新建）。
 *
 * 为什么单开文件：仓内惯例是「每个能力在**自己的**测试文件里锁提示词那半边」
 * （search_web → search-nudge.test.ts，generate_quiz → tools/generate-quiz.test.ts），
 * 但「图文结合」没有自己的运行时模块——它只活在提示词里，故锁也放这里。
 * 纯字符串断言，零 IO、零 DB。
 */
import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from './system-prompt.js';

describe('SYSTEM_PROMPT 图解引导（```svg 围栏）', () => {
  it('★ 点名 ```svg 围栏并带渲染器认得的硬约束（viewBox / 宽 ≤680）', () => {
    // 渲染侧通道早已存在（web/src/lib/markdown.ts 的 svg 块 + SvgPreviewCard 净化），
    // 但模型不被告知就永远不用——漏写引导 = 那个能力对模型等于不存在。
    expect(SYSTEM_PROMPT).toContain('```svg');
    expect(SYSTEM_PROMPT).toContain('viewBox');
    expect(SYSTEM_PROMPT).toContain('680');
  });

  it('引导是正面强制口径，不是劝说式负面措辞（quiz-image v1.0→v1.1 实测教训）', () => {
    // v1.0 那套「文字说得清就不要配图」的措辞实测等于送模型免费逃逸口（同一模型改前 0 图、改后 2~3 图/组），
    // 故本条引导写成「必须画，不能只写如图却不给图」——锁住这个形状，防止将来被改回负面劝说。
    expect(SYSTEM_PROMPT).toContain('必须');
    expect(SYSTEM_PROMPT).toContain('如图');
  });

  it('反向锁：提示词绝不含 mermaid——渲染器没有该通道（markdown.test.ts 把它锁成代码块）', () => {
    // 若有人只改提示词不加渲染器，模型会输出 mermaid 源码文本给学生看。
    // 真要支持 mermaid 是「渲染器 + 该锁 + markdown.test.ts L57」一并改的独立工程。
    expect(SYSTEM_PROMPT).not.toContain('mermaid');
  });
});

describe('普通对话学习结构', () => {
  it('知识讲解结论先行、关键词定位、步骤解释原因与结果', () => {
    for (const line of ['一句话给核心结论', '关键词：', '为什么这样做', '如何接下一步', '图配在对应解释旁']) expect(SYSTEM_PROMPT).toContain(line);
    expect(SYSTEM_PROMPT).toContain('先求解并验算，再写开篇结论');
  });
  it('引导式、闲聊和短回答不被统一模板覆盖', () => {
    for (const line of ['闲聊、操作回执和仅出题不用', '引导式口吻或 GrillMe', '不抢先泄露', '本轮明确请求', '简短档不强行展开']) expect(SYSTEM_PROMPT).toContain(line);
    expect(SYSTEM_PROMPT).toContain('不能仅因为存在多种讲法就先弹选择卡');
  });
  it('自检自愿且用现役GrillMe，正式题继续走工具，不新增层协议', () => {
    expect(SYSTEM_PROMPT).toContain('只给一个自愿的下一步');
    expect(SYSTEM_PROMPT).toContain('选当前对话范围');
    expect(SYSTEM_PROMPT).toContain('正式出题仍用 generate_quiz');
    expect(SYSTEM_PROMPT).not.toContain('[LAYERS]');
  });
});
