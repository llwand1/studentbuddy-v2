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
import { DEFAULT_ANSWER_STYLE } from '@sb/shared';
import { buildChatStyleBlock } from './learning-reply.js';

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

  it('自动布局图解与手绘 SVG 分工明确，约束配置与外部资源', () => {
    expect(SYSTEM_PROMPT).toContain('```mermaid');
    expect(SYSTEM_PROMPT).toContain('不用配置指令、HTML、外链或点击');
    expect(SYSTEM_PROMPT).toContain('几何、受力、电路等用 ```svg');
  });
});

describe('普通对话学习结构', () => {
  it('模型获知可用卡片及白底图面，引导式不先交付答案', () => {
    const ordinary = buildChatStyleBlock(DEFAULT_ANSWER_STYLE);
    for (const variant of ['CORE', 'STEP', 'EXAMPLE', 'PITFALL', 'CHECK']) expect(ordinary).toContain(`[!${variant}]`);
    expect(ordinary).toContain('简短档至多一张卡');
    expect(ordinary).toContain('用户要求纯文本时不用卡');
    const route = buildChatStyleBlock(DEFAULT_ANSWER_STYLE, '解方程 2x=16');
    expect(route).toContain('[!ROUTE]');
    expect(route).not.toContain('[!CORE] 惯性');
    const socratic = buildChatStyleBlock({ ...DEFAULT_ANSWER_STYLE, tone: 'socratic' });
    expect(socratic).not.toContain('[!CORE]');
    expect(socratic).toContain('引导式先提问');
    expect(SYSTEM_PROMPT).toContain('白色背景');
    expect(SYSTEM_PROMPT).toContain('至少 16px');
    expect(ordinary).toContain('不用 generate_image 或搜索图片代替');
    expect(ordinary).toContain('绝不编造 /api/images/ 地址');
    expect(ordinary).toContain('收尾邀请直接写一句，不用 ask_choice');
    expect(ordinary).toContain('工具都返回后才交付完整回答一次');
  });
  it('知识讲解结论先行、关键词定位、步骤解释原因与结果', () => {
    const block = buildChatStyleBlock(DEFAULT_ANSWER_STYLE);
    for (const line of ['一句话给核心结论', '关键词：', '为什么这样做', '如何接下一步', '图配在对应解释旁']) expect(block).toContain(line);
    expect(block).toContain('计算题开篇先给求解路线，不先报最终数值');
    expect(block).toContain('把结果与代入验算放在一起');
    expect(block).toContain('界面支持 KaTeX');
    expect(block).toContain('相邻等价变形用一个 aligned 环境');
    expect(block).toContain('结果与验算写在 CHECK 卡');
    expect(block).toContain('用户明确要 LaTeX 源码时用普通代码围栏');
    const calculation = buildChatStyleBlock(DEFAULT_ANSWER_STYLE, '解方程 2(x-3)+4=14。');
    expect(calculation).toContain('开篇只给求解路线');
    expect(calculation).not.toContain('先用一句话给核心结论');
    expect(buildChatStyleBlock(DEFAULT_ANSWER_STYLE, '什么是计算机？')).toContain('先用一句话给核心结论');
  });
  it('引导式、闲聊和短回答不被统一模板覆盖', () => {
    const brief = buildChatStyleBlock({ ...DEFAULT_ANSWER_STYLE, verbosity: 'brief' });
    const socratic = buildChatStyleBlock({ ...DEFAULT_ANSWER_STYLE, tone: 'socratic' });
    expect(brief).toContain('两三句内，不强行分步');
    expect(socratic).toContain('先问一个关键问题');
    expect(socratic).not.toContain('先用一句话给核心结论');
    expect(brief).toContain('闲聊、操作回执和仅出题不用');
    expect(SYSTEM_PROMPT).toContain('不能仅因为存在多种讲法就先弹选择卡');
  });
  it('自检自愿且用现役GrillMe，正式题继续走工具，不新增层协议', () => {
    const block = buildChatStyleBlock(DEFAULT_ANSWER_STYLE);
    expect(block).toContain('只给一个自愿的下一步');
    expect(block).toContain('选当前对话范围');
    expect(block).toContain('正式出题仍用 generate_quiz');
    expect(block).not.toContain('[LAYERS]');
    expect(SYSTEM_PROMPT).toContain('完整讲解等所需工具返回后只给一次');
  });
});
