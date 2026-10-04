/**
 * reader-store：侧栏阅读器的导航状态机（契约 `docs/SOURCE-TRACE-SPEC.md` §14.2）。
 *
 * 钉的是三条会被人直接感知的口径：
 *   ① **每一跳都要人点头**：`askFollow` 只挂确认条、不翻页；只有 `commitFollow` 才真的换页。
 *      （这条同时是授权模型本身——越界必须对应一次明确的人类点击）
 *   ② **换资料 / 换会话 = 全新阅读**：返回栈清空，否则「返回」会把人带回另一条资料，语义错乱。
 *   ③ **迟到的响应不覆盖当前页**：用户已经翻走了，上一页的取页结果到了也得丢。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  askFollow,
  cancelFollow,
  commitFollow,
  getReaderNav,
  readerBack,
  readerLoaded,
  readerNotice,
  resetReaderNav,
  siteLabelOf,
  startReading,
} from './reader-store';

const page = (url: string) => ({ ok: true as const, url, title: `T:${url}`, site: 'e.com', byline: '', blocks: [], thin: false });

beforeEach(() => resetReaderNav());

describe('① 跳转必须经过确认', () => {
  it('askFollow 只挂确认条，当前页不动', () => {
    startReading('s1', 'https://e.com/a', 'A');
    askFollow('https://e.com/b', '去 B');
    const st = getReaderNav();
    expect(st.pending).toMatchObject({ url: 'https://e.com/b', site: 'e.com' });
    expect(st.url).toBe('https://e.com/a'); // 没翻页
    expect(st.stack).toHaveLength(0);
  });

  it('取消 ⇒ 确认条收起、仍停在原页', () => {
    startReading('s1', 'https://e.com/a', 'A');
    askFollow('https://e.com/b', '去 B');
    cancelFollow();
    expect(getReaderNav().pending).toBeNull();
    expect(getReaderNav().url).toBe('https://e.com/a');
  });

  it('确认后才换页，并把原页压进返回栈', () => {
    startReading('s1', 'https://e.com/a', 'A');
    askFollow('https://e.com/b', '去 B');
    commitFollow('https://e.com/b', '去 B');
    const st = getReaderNav();
    expect(st.url).toBe('https://e.com/b');
    expect(st.pending).toBeNull();
    expect(st.loading).toBe(true);
    expect(st.stack).toEqual([{ url: 'https://e.com/a', title: 'A' }]);
  });

  it('返回回到上一页并弹栈；栈空时 readerBack 是空操作', () => {
    startReading('s1', 'https://e.com/a', 'A');
    commitFollow('https://e.com/b', 'B');
    readerBack();
    expect(getReaderNav().url).toBe('https://e.com/a');
    expect(getReaderNav().stack).toHaveLength(0);
    readerBack();
    expect(getReaderNav().url).toBe('https://e.com/a'); // 不炸、不乱跳
  });
});

describe('② 换资料 / 换会话 = 全新阅读', () => {
  it('切到另一条资料 ⇒ 返回栈清空', () => {
    startReading('s1', 'https://e.com/a', 'A');
    commitFollow('https://e.com/b', 'B');
    expect(getReaderNav().stack).toHaveLength(1);
    startReading('s1', 'https://e.com/c', 'C');
    expect(getReaderNav().stack).toHaveLength(0);
    expect(getReaderNav().url).toBe('https://e.com/c');
  });

  it('同会话同网址重复调用是空操作（面板重渲染不该把人踢回页首）', () => {
    startReading('s1', 'https://e.com/a', 'A');
    commitFollow('https://e.com/b', 'B');
    startReading('s1', 'https://e.com/b', 'B');
    expect(getReaderNav().stack).toHaveLength(1); // 没被清
  });

  it('换会话 ⇒ 状态整体重来', () => {
    startReading('s1', 'https://e.com/a', 'A');
    startReading('s2', 'https://e.com/a', 'A');
    expect(getReaderNav().sessionId).toBe('s2');
    expect(getReaderNav().stack).toHaveLength(0);
  });
});

describe('③ 迟到的响应与失败提示', () => {
  it('响应对应的不是当前页 ⇒ 丢弃，不覆盖', () => {
    startReading('s1', 'https://e.com/a', 'A');
    commitFollow('https://e.com/b', 'B');
    readerLoaded('https://e.com/a', page('https://e.com/a')); // 上一页的迟到响应
    expect(getReaderNav().page).toBeNull();
    readerLoaded('https://e.com/b', page('https://e.com/b'));
    expect(getReaderNav().page?.ok).toBe(true);
    expect(getReaderNav().loading).toBe(false);
  });

  it('readerNotice 收确认条并停掉 loading（失败不能一直转圈）', () => {
    startReading('s1', 'https://e.com/a', 'A');
    askFollow('https://e.com/b', 'B');
    readerNotice('跳不过去');
    const st = getReaderNav();
    expect(st.notice).toBe('跳不过去');
    expect(st.pending).toBeNull();
    expect(st.loading).toBe(false);
  });
});

describe('siteLabelOf', () => {
  it('取主机名并去掉 www；取不出就原样回网址', () => {
    expect(siteLabelOf('https://www.example.com/a/b')).toBe('example.com');
    expect(siteLabelOf('不是网址')).toBe('不是网址');
  });
});
