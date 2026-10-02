// @vitest-environment jsdom
/**
 * Landing.test — 落地页组件级回归锁（2026-09-19 上线；2026-09-20 扩充锁）。
 *
 * 锁的是「门面动线」：未登录先看到介绍而非应用；「开始使用」展开**注册**卡、
 * 「登录」展开**登录**卡（两种初始模式）、再点一次收起；功能卡与三步引导齐备。
 * 表单本体是复用的 `AccountBox`（standalone），其行为由既有链路与服务端测试兜住，
 * 这里只锁「卡有没有出现、初始模式对不对」。
 *
 * ★ 2026-09-20 新增两组锁，对应本次的三件改动：
 *   ① hero 叙事换血（标题改写 + 词条旅程段 + 演示窗）—— 锁「首屏有没有把词条讲出来」；
 *   ② 演示动画落地 —— 锁「演示窗在不在、从第 0 帧起、阶段点齐不齐」，
 *      以及**词条高亮的首现/复现两档线型**（这是真机口径，两档混同就是功能退化）。
 *   播放器的计时推进**刻意不测**：它靠 setTimeout 驱动，用假时钟测等于测「setTimeout 会不会响」，
 *   而真正的风险点在帧渲染口径（已由第三组锁覆盖）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { Landing } from './Landing';
import { LANDING_LANG_KEY } from './landing-lang';
import { LANDING_DEMOS } from './demo/registry';
import { TermFlowDemo } from './demo/TermFlowDemo';

/**
 * ★★ 2026-09-22：整页**钉在中文口径**上跑。
 *   jsdom 的 `navigator.language` 是 `'en-US'` ⇒ 不钉的话首探会把整页判成英文，
 *   而下面这些锁读的全是中文文案（它们锁的是门面动线，不是语言）。英文侧另有
 *   `LandingLang.test.tsx` 专锁（切换、记忆、首探判定、打字机时长预算）。
 *   写在模块顶层而不是每个用例里：`LandingLangProvider` 只在挂载时读一次。
 */
window.localStorage.setItem(LANDING_LANG_KEY, 'zh');

/**
 * ★ 2026-09-24：`Landing` 里那句裸 `fetch('/api/auth/providers')` 换成了 `api.auth.surface()`
 * ——那条请求是服务端 `app_open` 的采集点，归因头只在 api 层注入。换路之后桩 fetch 已经桩不到它
 * （`api` 整个被 mock 掉）⇒ 桩点跟着上移一层。
 * ★ 同时把「公用体验入口」那组锁搬到了 `LandingDemoEntry.test.tsx`（本文件当时贴 300 行红线），
 *   所以这里**不再需要按用例改桩**：默认「问不到 providers」＝两个体验入口都不画，门面动线照旧。
 */
vi.mock('../lib/api', () => ({
  // DemoLoginButton 顶层 `import { api, ApiError }`——mock 工厂必须两个都给，缺一个就是链接期报错
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string, public body?: unknown) {
      super(message);
    }
  },
  api: {
    auth: {
      // 未登录：me 401（AccountBox 挂载即问，正常状态不是异常）
      me: () => Promise.reject(new Error('401')),
      // 默认「问不到」＝两个入口都不画（开关在上游，点了报错的按钮不如没有）
      surface: () => Promise.reject(new Error('本文件的用例不桩 providers（体验入口锁在 LandingDemoEntry.test.tsx）')),
      sendCode: () => Promise.resolve({ ok: true, expiresInMs: 60_000 }),
      register: () => Promise.reject(new Error('unused-in-this-test')),
      demoLogin: () => Promise.reject(new Error('unused-in-this-test')),
    },
  },
}));

afterEach(cleanup);

describe('Landing — 未登录门面（2026-09-28 冒险录版式）', () => {


  it('★ 门面只讲游戏化玩法：下线的旧功能与工程讲解不再出现', () => {
    const { container } = render(<Landing onAuthed={() => undefined} />);
    const text = container.textContent ?? '';
    for (const gone of ['薄弱分析', '学习流编排', '知识图谱', '每日总结', '刷题笔记', 'AI 输出可靠性工程', '联网检索', '文档模式']) {
      expect(text).not.toContain(gone);
    }
    expect(LANDING_DEMOS.map((d) => d.key)).not.toContain('graph-flow');
  });





  it('点「开始使用」→ 展开注册卡（提交按钮是「注册并登录」）；再点一次收起', () => {
    const { getByText, queryByPlaceholderText, queryByText } = render(<Landing onAuthed={() => undefined} />);
    fireEvent.click(getByText('开始使用'));
    expect(queryByPlaceholderText('邮箱')).toBeTruthy();
    expect(queryByText('注册并登录')).toBeTruthy();
    fireEvent.click(getByText('开始使用'));
    expect(queryByPlaceholderText('邮箱')).toBeNull();
  });

  it('终章「踏上大陆」也能展开注册卡', () => {
    const { getByText, queryByPlaceholderText } = render(<Landing onAuthed={() => undefined} />);
    window.scrollTo = () => undefined;
    fireEvent.click(getByText('踏上大陆'));
    expect(queryByPlaceholderText('邮箱')).toBeTruthy();
  });

  it('点「登录」→ 展开登录卡（提交按钮是「登录」，不是注册）', () => {
    const { getAllByText, getByPlaceholderText, queryByText } = render(<Landing onAuthed={() => undefined} />);
    fireEvent.click(getAllByText('登录')[0]!);
    expect(getByPlaceholderText('邮箱')).toBeTruthy();
    expect(queryByText('注册并登录')).toBeNull();
  });
});

describe('词条演示 — 高亮口径', () => {

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
