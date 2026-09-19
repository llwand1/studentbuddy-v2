// @vitest-environment jsdom
/**
 * Landing.test — 落地页组件级回归锁（2026-09-19 上线批）。
 *
 * 锁的是「门面动线」：未登录先看到介绍而非应用；「开始使用」展开**注册**卡、
 * 「登录」展开**登录**卡（两种初始模式）、再点一次收起；六张功能卡与三步引导齐备。
 * 表单本体是复用的 `AccountBox`（standalone），其行为由既有链路与服务端测试兜住，
 * 这里只锁「卡有没有出现、初始模式对不对」。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { Landing } from './Landing';

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
  it('渲染标题、副文案、六张功能卡与三步引导；默认不出登录卡', () => {
    const { getByText, queryByPlaceholderText } = render(<Landing onAuthed={() => undefined} />);
    expect(getByText('你的专属学习助手')).toBeTruthy();
    expect(getByText('开始使用')).toBeTruthy();
    expect(getByText('学习流编排')).toBeTruthy();
    expect(getByText('知识图谱')).toBeTruthy();
    expect(getByText('智能出题')).toBeTruthy();
    expect(getByText('艾宾浩斯复习')).toBeTruthy();
    expect(getByText('AI 对战')).toBeTruthy();
    expect(getByText('笔记与总结')).toBeTruthy();
    // 扩容批：五环闭环 / 工程较真 / 隐私自持三段齐备，默认也全渲染（门面一次讲完）
    expect(getByText('对话讲解')).toBeTruthy();
    expect(getByText('薄弱分析')).toBeTruthy();
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
