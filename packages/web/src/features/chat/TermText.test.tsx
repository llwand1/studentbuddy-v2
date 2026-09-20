// @vitest-environment jsdom
/**
 * TermText.test — 正文词条高亮与词条卡的组件级回归锁
 * （契约 `docs/TERM-HIGHLIGHT-SPEC.md` §9）。
 *
 * 钉的是「屏幕上的东西真的出来了」这一层：命中切成高亮 span、首现/复现分档、
 * 悬停出速览卡、点击出完整卡、动作真的打到接口上、**无 Provider 时不报错也不高亮**。
 * 匹配规则本身（边界/大小写/重叠）在 `shared/term-highlight.test.ts`，这里不重复。
 * v1.1 追加**英文发音**：喇叭出不出现（中英分档、别名命中、环境不支持）与点了读的是什么
 * ——判定规则本身在 `lib/speech.test.ts`，这里只钉「接线接对了没」。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { TermIndexProvider } from './term-index';
import { TermText } from './TermText';
import { api, type TermItem } from '../../lib/api';

vi.mock('../../lib/api', () => ({
  api: { terms: { list: vi.fn(), scopeTerm: vi.fn() } },
}));

/** 测试里禁 `!` 非空断言（AGENTS.md 红线）：要断存在就写会抛错的辅助函数 */
function must<T>(v: T | null | undefined, what = '节点'): T {
  if (v === null || v === undefined) throw new Error(`找不到${what}`);
  return v;
}

/**
 * `SpeechSynthesisUtterance` 的最小替身——jsdom **不实现**语音 API，
 * 不打桩则 `canSpeak()` 恒假、喇叭永不出现（判定规则的边界在 `lib/speech.test.ts` 另测）。
 */
class FakeUtterance {
  text: string;
  lang = '';
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

let spoken: FakeUtterance | null = null;
const cancelMock = vi.fn();
const speakMock = vi.fn((u: FakeUtterance) => {
  spoken = u;
});

const TERM: TermItem = {
  id: 'term-1',
  term: '闭包',
  definition: '函数 + 它定义时的词法作用域',
  domain: 'cs',
  aliases: ['closure'],
  source_session_id: null,
  source_title: null,
  importance: 0.8,
  usage_count: 12,
  last_used_at: null,
  created_at: '2026-09-01 00:00:00',
  updated_at: '2026-09-01 00:00:00',
  review_stage: 2,
  last_reviewed_at: '2026-09-10 00:00:00',
  review_in_scope: 1,
  review_enabled: null,
};

const listMock = () => vi.mocked(api.terms.list);
const scopeMock = () => vi.mocked(api.terms.scopeTerm);

/** 渲染一段正文（可选注入 openTerms 与自定义词条表） */
function setup(text: string, opts: { openTerms?: (k: string) => void; terms?: TermItem[] } = {}) {
  listMock().mockResolvedValue(opts.terms ?? [TERM]);
  const r = render(
    <TermIndexProvider {...(opts.openTerms ? { onOpenTerms: opts.openTerms } : {})}>
      <p>
        <TermText text={text} />
      </p>
    </TermIndexProvider>,
  );
  return r;
}

const hls = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>('.term-hl'));
const card = () => document.querySelector('.term-card');

beforeEach(() => {
  vi.clearAllMocks();
  scopeMock().mockResolvedValue({ enabled: true, resetCount: 1 });
  // jsdom 没有语音 API：不打桩则 canSpeak() 恒假、喇叭永不出现
  spoken = null;
  vi.stubGlobal('speechSynthesis', { cancel: cancelMock, speak: speakMock });
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('高亮切分', () => {
  it('命中词条（含别名）切成高亮 span，文本内容一字不差', async () => {
    const { container } = setup('闭包（closure）捕获变量引用');
    await waitFor(() => expect(hls(container)).toHaveLength(2));
    expect(hls(container).map((e) => e.textContent)).toEqual(['闭包', 'closure']);
    expect(container.textContent).toBe('闭包（closure）捕获变量引用');
  });

  it('无命中的片段原样渲染、不产生额外节点（用另一段的命中证明索引已就绪）', async () => {
    listMock().mockResolvedValue([TERM]);
    const { container } = render(
      <TermIndexProvider>
        <p>
          <TermText text="闭包" />
        </p>
        <p>
          <TermText text="这句话里没有术语" />
        </p>
      </TermIndexProvider>,
    );
    await waitFor(() => expect(hls(container)).toHaveLength(1));
    const plain = must(container.querySelectorAll('p')[1], '第二段');
    expect(plain.textContent).toBe('这句话里没有术语');
    expect(plain.querySelector('.term-text')).toBeNull();
    expect(plain.childNodes).toHaveLength(1); // 只有一个文本节点
  });

  it('同一片段内：首现标 first，复现标 again（别名算同一词条的复现）', async () => {
    const { container } = setup('闭包 closure 与闭包');
    await waitFor(() => expect(hls(container)).toHaveLength(3));
    const cls = hls(container).map((e) => e.className);
    expect(cls[0]).toContain('first');
    expect(cls[1]).toContain('again');
    expect(cls[2]).toContain('again');
  });

  it('命中词带 data-term（主词条名，别名也归属主词条）', async () => {
    const { container } = setup('closure 是别名');
    await waitFor(() => expect(hls(container)).toHaveLength(1));
    expect(must(hls(container)[0]).dataset.term).toBe('闭包');
  });

  it('索引未就绪（接口失败）时不高亮、不报错（ADR-4 降级）', async () => {
    listMock().mockRejectedValue(new Error('boom'));
    const { container } = render(
      <TermIndexProvider>
        <p>
          <TermText text="闭包 closure" />
        </p>
      </TermIndexProvider>,
    );
    await waitFor(() => expect(listMock()).toHaveBeenCalled());
    expect(hls(container)).toHaveLength(0);
    expect(container.textContent).toBe('闭包 closure');
  });
});

describe('卡片两态', () => {
  it('悬停 → 速览卡（mini），内容含词名/领域/释义/已用次数', async () => {
    const { container } = setup('闭包');
    await waitFor(() => expect(hls(container)).toHaveLength(1));
    fireEvent.mouseOver(must(hls(container)[0]));
    await waitFor(() => expect(card()).not.toBeNull());
    const c = must(card());
    expect(c.className).toContain('mini');
    expect(c.textContent).toContain('闭包');
    expect(c.textContent).toContain('cs');
    expect(c.textContent).toContain('函数 + 它定义时的词法作用域');
    expect(c.textContent).toContain('已用 12 次');
  });

  it('点击 → 完整卡（含别名、复习状态与动作按钮）', async () => {
    const { container } = setup('闭包', { openTerms: vi.fn() });
    await waitFor(() => expect(hls(container)).toHaveLength(1));
    fireEvent.click(must(hls(container)[0]));
    await waitFor(() => expect(card()).not.toBeNull());
    const c = must(card());
    expect(c.className).not.toContain('mini');
    expect(c.textContent).toContain('别名');
    expect(c.textContent).toContain('closure');
    expect(c.textContent).toContain('天'); // reviewStateLabel 的「N 天…」
    expect(screen.getByText('移出复习')).toBeDefined(); // review_in_scope=1 → 可移出
    expect(screen.getByText('打开词条库')).toBeDefined();
  });

  it('未纳入复习范围的词条：不显示复习天数，主按钮是「纳入复习」', async () => {
    const { container } = setup('闭包', { terms: [{ ...TERM, review_in_scope: 0 }] });
    await waitFor(() => expect(hls(container)).toHaveLength(1));
    fireEvent.click(must(hls(container)[0]));
    await waitFor(() => expect(card()).not.toBeNull());
    expect(must(card()).textContent).toContain('未纳入复习范围');
    expect(screen.getByText('纳入复习')).toBeDefined();
  });

  it('点「移出复习」真的打到 scopeTerm（带上词条 id 与目标值 false）', async () => {
    const { container } = setup('闭包');
    await waitFor(() => expect(hls(container)).toHaveLength(1));
    fireEvent.click(must(hls(container)[0]));
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(screen.getByText('移出复习'));
    await waitFor(() => expect(scopeMock()).toHaveBeenCalledWith('term-1', false));
    await waitFor(() => expect(must(card()).textContent).toContain('已移出复习范围'));
  });

  it('点「打开词条库」把主词条名交回上层', async () => {
    const onOpenTerms = vi.fn();
    const { container } = setup('闭包', { openTerms: onOpenTerms });
    await waitFor(() => expect(hls(container)).toHaveLength(1));
    fireEvent.click(must(hls(container)[0]));
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(screen.getByText('打开词条库'));
    expect(onOpenTerms).toHaveBeenCalledWith('闭包');
  });

  it('未注入 openTerms 时不出现「打开词条库」（不做假按钮）', async () => {
    const { container } = setup('闭包');
    await waitFor(() => expect(hls(container)).toHaveLength(1));
    fireEvent.click(must(hls(container)[0]));
    await waitFor(() => expect(card()).not.toBeNull());
    expect(screen.queryByText('打开词条库')).toBeNull();
  });

  it('完整卡的 × 关闭卡片', async () => {
    const { container } = setup('闭包');
    await waitFor(() => expect(hls(container)).toHaveLength(1));
    fireEvent.click(must(hls(container)[0]));
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(screen.getByLabelText('关闭词条卡'));
    await waitFor(() => expect(card()).toBeNull());
  });
});

describe('英文发音（契约 §3.1 v1.1）', () => {
  it('中文词条的卡里没有喇叭——不发音', async () => {
    const { container } = setup('闭包');
    await waitFor(() => expect(hls(container)).toHaveLength(1));
    fireEvent.click(must(hls(container)[0]));
    await waitFor(() => expect(card()).not.toBeNull());
    expect(screen.queryByLabelText('朗读发音')).toBeNull();
  });

  it('★ 别名命中：正文显示 closure、主词条是「闭包」，喇叭在，且读的是 closure 不是「闭包」', async () => {
    const { container } = setup('closure 是别名');
    await waitFor(() => expect(hls(container)).toHaveLength(1));
    // data-term 仍是主词条名（查卡片用），data-say 才是命中原文（发音用）——两者不可合并
    expect(must(hls(container)[0]).dataset.term).toBe('闭包');
    expect(must(hls(container)[0]).dataset.say).toBe('closure');
    fireEvent.click(must(hls(container)[0]));
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(screen.getByLabelText('朗读发音'));
    await waitFor(() => expect(speakMock).toHaveBeenCalled());
    expect(must(spoken, '朗读请求').text).toBe('closure');
    expect(must(spoken, '朗读请求').lang).toBe('en-US');
  });

  it('悬停速览卡（mini）也有喇叭——最顺手的那一态不该少', async () => {
    const { container } = setup('closure 是别名');
    await waitFor(() => expect(hls(container)).toHaveLength(1));
    fireEvent.mouseOver(must(hls(container)[0]));
    await waitFor(() => expect(card()).not.toBeNull());
    expect(must(card()).className).toContain('mini');
    expect(screen.getByLabelText('朗读发音')).toBeDefined();
  });

  it('★ 朗读失败时给提示，且 mini 卡上也看得见（提示行已移到两态之外）', async () => {
    const { container } = setup('closure 是别名');
    await waitFor(() => expect(hls(container)).toHaveLength(1));
    fireEvent.mouseOver(must(hls(container)[0]));
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(screen.getByLabelText('朗读发音'));
    // ★ `speakEnglish` 自本批起是 async（要先 `await` 一次「取朗读设置」）⇒ 断言 utterance
    //   之前必须等它真的被构造出来，否则 `spoken` 还是 null（症状是「找不到朗读请求」）
    await waitFor(() => expect(spoken).not.toBeNull());
    must(spoken, '朗读请求').onerror?.({ error: 'synthesis-failed' });
    await waitFor(() => expect(must(card()).textContent).toContain('朗读失败'));
  });

  it('★ 环境不支持语音时不渲染喇叭（不做假按钮）', async () => {
    vi.unstubAllGlobals();
    const { container } = setup('closure 是别名');
    await waitFor(() => expect(hls(container)).toHaveLength(1));
    fireEvent.click(must(hls(container)[0]));
    await waitFor(() => expect(card()).not.toBeNull());
    expect(screen.queryByLabelText('朗读发音')).toBeNull();
  });
});

describe('无 Provider（笔记页等其他 Markdown 调用点）', () => {
  it('原样渲染文本、不高亮、不报错', () => {
    const { container } = render(
      <p>
        <TermText text="闭包 closure 都在这里" />
      </p>,
    );
    expect(container.textContent).toBe('闭包 closure 都在这里');
    expect(hls(container)).toHaveLength(0);
    expect(card()).toBeNull();
  });
});
