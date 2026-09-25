/**
 * chat/system-prompt —— 系统提示词本身的回归锁（2026-09-24 主聊天 AI 图解能力批新建）。
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
    // 但模型不被告知就永远不用——漏写引导 = 那个能力对模型等于不存在（B-006 口径）。
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
    // 真要支持 mermaid 是「渲染器 + 该锁 + markdown.test.ts L57」同批改的独立工程。
    expect(SYSTEM_PROMPT).not.toContain('mermaid');
  });
});
