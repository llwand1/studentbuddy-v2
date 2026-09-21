// @vitest-environment jsdom
/**
 * Landing.test — 落地页组件级回归锁（2026-09-19 上线批；2026-09-20 hero 重构批扩锁）。
 *
 * 锁的是「门面动线」：未登录先看到介绍而非应用；「开始使用」展开**注册**卡、
 * 「登录」展开**登录**卡（两种初始模式）、再点一次收起；功能卡与三步引导齐备。
 * 表单本体是复用的 `AccountBox`（standalone），其行为由既有链路与服务端测试兜住，
 * 这里只锁「卡有没有出现、初始模式对不对」。
 *
 * ★ 2026-09-20 hero 重构批新增两组锁，对应本批的三件改动：
 *   ① hero 叙事换血（标题改写 + 词条旅程段 + 演示窗）—— 锁「首屏有没有把词条讲出来」；
 *   ② 演示动画落地 —— 锁「演示窗在不在、从第 0 帧起、阶段点齐不齐」，
 *      以及**词条高亮的首现/复现两档线型**（这是真机口径，两档混同就是功能退化）。
 *   播放器的计时推进**刻意不测**：它靠 setTimeout 驱动，用假时钟测等于测「setTimeout 会不会响」，
 *   而真正的风险点在帧渲染口径（已由第三组锁覆盖）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { Landing } from './Landing';
import { LANDING_DEMOS, TERM_FLOW } from './demo/registry';
import { TermFlowDemo } from './demo/TermFlowDemo';

vi.mock('../lib/api', () => ({
  api: {
    auth: {
      // 未登录：me 401（AccountBox 挂载即问，正常状态不是异常）
      me: () => Promise.reject(new Error('401')),
      sendCode: () => Promise.resolve({ ok: true, expiresInMs: 60_000 }),
      register: () => Promise.reject(new Error('unused-in-this-test')),
    },
  },
}));

afterEach(cleanup);

describe('Landing — 未登录门面', () => {
  it('渲染 hero 标题与演示窗、词条旅程五步、功能九宫格与三步引导；默认不出登录卡', () => {
    const { getByText, queryByPlaceholderText, container } = render(<Landing onAuthed={() => undefined} />);
    // hero 叙事（2026-09-20 批）：标题换成「词条留下来」的核心主张。
    // ★ 用 container 读整串而不是 getByText：标题里嵌了 <span class="landing-accent">，
    //   而 getByText 只拼元素的**直接文本子节点**（不含后代），跨 span 的整串它匹配不到
    //   （实测踩过：报 unable to find an element with the text）。
    expect(container.querySelector('.landing-title')?.textContent).toBe('学过的词，会自己留下来');
    expect(getByText('开始使用')).toBeTruthy();
    // 词条旅程五步（2026-09-21 B 回路批改锁）：五步现在**各出现两次**——环上药丸 + 右侧清单，
    // `getByText` 遇到多个即抛。改成锁结构，而且这比原来**更强**：
    // 原来只保证「这几个字在页面某处」，现在保证「环与清单各成一套、且顺序一致」。
    // ★ 2026-09-21 对战双屏批：`PkJourney` **故意复用**了 `.landing-jsteps` / `.landing-jstep`
    //   / `.landing-feature-title` 这套清单类（同一种列表样式不该抄两份），于是页面上一条
    //   `querySelectorAll('.landing-jsteps …')` 会数到 10 项。故这几把锁一律**限定在词条段内**
    //   ——限定不是削弱：那段自己的结构由 `PkJourney.test.tsx` 锁，两边各锁各的。
    const JOURNEY = ['抽词', '高亮', '注入', '复习', '沉淀'];
    const term = 'section[aria-label="词条的完整旅程"]';
    const inTerm = (sel: string) => [...container.querySelectorAll(`${term} ${sel}`)];
    expect(inTerm('.landing-orbit-node').map((n) => n.textContent)).toEqual(JOURNEY);
    expect(inTerm('.landing-jsteps .landing-feature-title').map((n) => n.textContent)).toEqual(JOURNEY);
    // 环与清单必须**同步**（本批的设计就是一个时钟派生两侧；两条独立时钟一定会漂）
    expect(inTerm('.landing-orbit-node.hot').length).toBe(1);
    expect(inTerm('.landing-jstep.hot').length).toBe(1);
    // 诚实标注那一行不许删：它写明转速是压缩过的，删掉就等于让演示冒充真实节奏
    expect(inTerm('.landing-jnote')[0]?.textContent).toContain('2.6 秒转一圈');
    expect(inTerm('.landing-orbit-core')[0]?.textContent).toContain('已用次数');
    // 五环闭环（本批降到词条之后，但内容一条不能少）
    expect(getByText('对话讲解')).toBeTruthy();
    expect(getByText('薄弱分析')).toBeTruthy();
    // 功能九宫格：本批把「艾宾浩斯复习」换成「词条高亮」
    // （复习已在词条旅程第 4 步讲得更透，此处让位给原先落地页完全没出现的高亮卡交互）
    expect(getByText('学习流编排')).toBeTruthy();
    expect(getByText('知识图谱')).toBeTruthy();
    expect(getByText('智能出题')).toBeTruthy();
    expect(getByText('词条高亮')).toBeTruthy();
    expect(getByText('AI 对战')).toBeTruthy();
    expect(getByText('笔记与总结')).toBeTruthy();
    // 工程较真/隐私自持两段齐备，默认也全渲染（门面一次讲完）
    expect(getByText('AI 输出可靠性工程')).toBeTruthy();
    expect(getByText('不锁定供应商')).toBeTruthy();
    expect(getByText('免费注册')).toBeTruthy(); // 隐私段的 CTA（标题跨 span 拆分，不整串匹配）
    // GitHub 横幅（显眼位）与本地安装包版引导
    expect(getByText('本项目完全开源')).toBeTruthy();
    expect(getByText('github.com/llwand1/studentbuddy-v2')).toBeTruthy();
    expect(getByText('本地安装包版')).toBeTruthy(); // 引导句被 <b> 拆分，锚定粗体词
    expect(getByText('邮箱注册账号')).toBeTruthy();
    expect(queryByPlaceholderText('邮箱')).toBeNull(); // 默认收起：介绍在前，表单不抢镜
  });

  it('演示窗从第 0 帧起：标题在、首帧说明在、阶段点数与该演示的帧数一致', () => {
    const { getByText, container } = render(<Landing onAuthed={() => undefined} />);
    // ★ 2026-09-20 知识图演示批起，`TERM_FLOW.title` 在页面上出现**两次**了——
    //   窗口标题栏（当前演示）+ 切换 Tab（两个演示各一个）。故不能用 getByText（遇多即抛），
    //   改断 `.ld-bar-title`；顺便把"默认停在第一个演示"也锁住（Tab 一多，默认选中项选错很难发现）。
    expect(container.querySelector('.ld-bar-title')?.textContent).toBe(TERM_FLOW.title);
    expect(container.querySelectorAll('.ld-tab').length).toBe(LANDING_DEMOS.length);
    expect(container.querySelector('.ld-tab.ld-tab-on')?.textContent).toBe(TERM_FLOW.title);
    expect(getByText('对话进行中：词条库里已有的词自动标出来')).toBeTruthy();
    expect(container.querySelectorAll('.ld-pip').length).toBe(TERM_FLOW.stages.length);
    // 第 0 帧：只有 1 个点处于选中态（错位就会让「现在演到哪」失去意义）
    expect(container.querySelectorAll('.ld-pip-on').length).toBe(1);
    expect(getByText('重播')).toBeTruthy();
  });

  it('点「开始使用」→ 展开注册卡（提交按钮是「注册并登录」）；再点一次收起', () => {
    const { getByText, queryByPlaceholderText, queryByText } = render(<Landing onAuthed={() => undefined} />);
    fireEvent.click(getByText('开始使用'));
    expect(queryByPlaceholderText('邮箱')).toBeTruthy();
    expect(queryByText('注册并登录')).toBeTruthy();
    fireEvent.click(getByText('开始使用'));
    expect(queryByPlaceholderText('邮箱')).toBeNull();
  });

  it('点「登录」→ 展开登录卡（提交按钮是「登录」，不是注册）', () => {
    const { getAllByText, getByPlaceholderText, queryByText } = render(<Landing onAuthed={() => undefined} />);
    fireEvent.click(getAllByText('登录')[0]!); // 顶栏 ghost 按钮（表单展开后提交按钮也叫「登录」，故取第一个）
    expect(getByPlaceholderText('邮箱')).toBeTruthy();
    expect(queryByText('注册并登录')).toBeNull();
  });
});

describe('词条演示 — 高亮口径', () => {
  // stage=2 ⇒ 打字机收工（useTyping 的 active 为假时直接给全文），文本完整可见
  it('首现实线、复现虚点线：同一个词连标两次不能是同一种线型', () => {
    const { container } = render(<TermFlowDemo stage={2} />);
    // 「梯度下降」1 次 + 「学习率」2 次 = 3 个高亮
    expect(container.querySelectorAll('.ld-mark').length).toBe(3);
    // 其中只有第二个「学习率」是复现 —— 复现数错位会让「首现」失去强调作用
    expect(container.querySelectorAll('.ld-mark-again').length).toBe(1);
  });

  it('速览卡在 `.ld-reply` 里面（2026-09-21 修的那条真 bug 的结构锁）', () => {
    const { container } = render(<TermFlowDemo stage={1} />);
    // 卡靠 `top:100%` 贴在正文下方，包含块必须是 `.ld-reply`。它一旦挪回 `.ld-layer`
    // 直接子级，百分比就改成对着 302px 的整层算，卡会掉到舞台外被 overflow:hidden 裁掉
    // ——实测量到过 y=537 / 舞台底 527，也就是那一帧从没画出卡来。
    // ★ jsdom 量不到布局，所以锁的是**那条父子关系本身**（它就是 bug 的唯一成因）。
    expect(container.querySelector('.ld-reply .ld-hover')).toBeTruthy();
    expect(container.querySelector('.ld-layer > .ld-hover')).toBeNull();
  });
});
