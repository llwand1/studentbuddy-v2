import { describe, it, expect } from 'vitest';
import { highlightCode, highlightStable, extFor } from './highlight';

const kinds = (code: string, lang: string): string[] =>
  (highlightCode(code, lang) ?? []).map((t) => t.t);

const text = (code: string, lang: string): string =>
  (highlightCode(code, lang) ?? []).map((t) => t.v).join('');

describe('highlightCode', () => {
  it('JS：注释/字符串/关键字/数字各归其类，普通字符为 x', () => {
    const ks = kinds('const n = 42; // 计数\nconst s = "hi";', 'js');
    expect(ks).toContain('kw');
    expect(ks).toContain('num');
    expect(ks).toContain('com');
    expect(ks).toContain('str');
    // 无损：拼回去必须与原文逐字一致（高亮绝不能吞字）
    expect(text('const n = 42; // 计数\nconst s = "hi";', 'js')).toBe('const n = 42; // 计数\nconst s = "hi";');
  });

  it('关键字必须整词命中：identifier 里的子串不着色', () => {
    const toks = highlightCode('const constant = 1;', 'js');
    expect(toks).toBeDefined();
    const kw = (toks ?? []).filter((t) => t.t === 'kw').map((t) => t.v);
    expect(kw).toEqual(['const']); // constant 不算关键字
  });

  it('函数调用名上 fn 色，但关键字优先（if ( 不误判成函数）', () => {
    const toks = highlightCode('if (foo()) return;', 'js') ?? [];
    const kw = toks.filter((t) => t.t === 'kw').map((t) => t.v);
    const fn = toks.filter((t) => t.t === 'fn').map((t) => t.v);
    expect(kw).toContain('if');
    expect(kw).toContain('return');
    expect(fn).toEqual(['foo']);
  });

  it('字符串里的关键字不被拆着色', () => {
    const toks = highlightCode('const s = "const return";', 'js') ?? [];
    const str = toks.filter((t) => t.t === 'str').map((t) => t.v);
    expect(str).toEqual(['"const return"']);
  });

  it('Python：三引号整段吃下（含换行），# 是注释', () => {
    const toks = highlightCode('def f():\n  """说明\ndoc"""\n# 注释', 'py') ?? [];
    const str = toks.filter((t) => t.t === 'str').map((t) => t.v);
    expect(str.some((s) => s.includes('doc'))).toBe(true);
    const com = toks.filter((t) => t.t === 'com').map((t) => t.v);
    expect(com).toEqual(['# 注释']);
  });

  it('JSON：键（冒号前）与值字符串分色，true/false/null 是关键字', () => {
    const toks = highlightCode('{"name": "app", "on": true, "n": null}', 'json') ?? [];
    const key = toks.filter((t) => t.t === 'key').map((t) => t.v);
    expect(key).toEqual(['"name"', '"on"', '"n"']); // 冒号前都是键
    expect(toks.some((t) => t.t === 'kw' && t.v === 'true')).toBe(true);
  });

  it('Bash：$VAR 上 var 色，# 后整行注释', () => {
    const toks = highlightCode('# 安装\ncd $HOME && npm run build', 'sh') ?? [];
    expect(toks.filter((t) => t.t === 'var').map((t) => t.v)).toEqual(['$HOME']);
    expect(toks.some((t) => t.t === 'com' && t.v === '# 安装')).toBe(true);
  });

  it('未闭合字符串容错：吃不到闭合也不崩、不吞掉后续内容', () => {
    const toks = highlightCode('const s = "abc;\nconst t = 1;', 'js');
    expect(toks).not.toBeNull();
    // 无损断言：拼回原文
    expect(text('const s = "abc;\nconst t = 1;', 'js')).toBe('const s = "abc;\nconst t = 1;');
  });

  it('不支持的语言返回 null（纯文本回落），空串返回 null', () => {
    expect(highlightCode('SELECT * FROM t', 'sql')).toBeNull();
    expect(highlightCode('const a = 1', 'rust')).toBeNull();
    expect(highlightCode('', 'js')).toBeNull();
  });

  it('语言别名：ts/typescript/jsx 都走 js 规则，大小写不敏感', () => {
    expect(kinds('const a: number = 1;', 'TS')).toContain('kw');
    expect(kinds('def f(): pass', 'Python')).toContain('kw');
  });

  it('extFor：语言 → 下载扩展名，映射不到回 txt', () => {
    expect(extFor('typescript')).toBe('ts');
    expect(extFor('py')).toBe('py');
    expect(extFor('rust')).toBe('txt');
  });
});

const DIFF = [
  'diff --git a/x.ts b/x.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
].join('\n');

describe('diff 高亮', () => {
  it('增行 add、删行 del、@@ 与 diff 头 hunk', () => {
    const toks = highlightCode(DIFF, 'diff') ?? [];
    const pick = (k: string): string[] => toks.filter((t) => t.t === k).map((t) => t.v);
    expect(pick('add')).toEqual(['+const b = 3;', '+const c = 4;']);
    expect(pick('del')).toEqual(['-const b = 2;']);
    expect(pick('hunk')).toContain('@@ -1,3 +1,4 @@');
    expect(pick('hunk')).toContain('diff --git a/x.ts b/x.ts');
  });

  it('+++ / --- 文件头判 hunk，不误判成增删行（三字符规则优先）', () => {
    const toks = highlightCode('--- a/x\n+++ b/x\n+real\n', 'diff') ?? [];
    const pick = (k: string): string[] => toks.filter((t) => t.t === k).map((t) => t.v);
    expect(pick('hunk')).toEqual(['--- a/x', '+++ b/x']);
    expect(pick('add')).toEqual(['+real']);
  });

  it('只认行首：行中的 - 不着色', () => {
    const toks = highlightCode(' const x = a - b;\n', 'diff') ?? [];
    expect(toks.some((t) => t.t === 'del' || t.t === 'add')).toBe(false);
  });

  it('无损：拼回原文', () => {
    expect((highlightCode(DIFF, 'diff') ?? []).map((t) => t.v).join('')).toBe(DIFF);
  });

  it('patch 是 diff 的别名', () => {
    expect((highlightCode('+a\n', 'patch') ?? []).some((t) => t.t === 'add')).toBe(true);
  });

  it('extFor：diff → .diff', () => {
    expect(extFor('diff')).toBe('diff');
    expect(extFor('patch')).toBe('diff');
  });
});

describe('highlightStable（流式：只上色已完整换行的部分）', () => {
  it('一行都没写完 → null（回落纯文本）', () => {
    expect(highlightStable('const a', 'js')).toBeNull();
  });

  it('已换行的行上色，末行原样不上色', () => {
    const toks = highlightStable('const a = 1;\nconst b', 'js') ?? [];
    const kw = toks.filter((t) => t.t === 'kw').map((t) => t.v);
    expect(kw).toEqual(['const']); // 只有第一行那个 const 着了色
    expect(toks[toks.length - 1]).toEqual({ t: 'x', v: 'const b' }); // 末行半截 → x
  });

  it('以换行结尾时不产生空尾段', () => {
    const toks = highlightStable('const a = 1;\n', 'js') ?? [];
    expect(toks.every((t) => t.v !== '')).toBe(true);
    expect(toks.map((t) => t.v).join('')).toBe('const a = 1;\n');
  });

  it('无损：拼回原文（含末行半截、含未闭合字符串）', () => {
    const src = 'const s = "abc\ndef();\nconst t';
    expect((highlightStable(src, 'js') ?? []).map((t) => t.v).join('')).toBe(src);
  });

  it('不支持的语言 → null', () => {
    expect(highlightStable('a\nb', 'rust')).toBeNull();
  });

  it('流式期 diff 也能上色：已换行的增删行即时着色', () => {
    const toks = highlightStable('+added\n-removed\n+half', 'diff') ?? [];
    expect(toks.filter((t) => t.t === 'add').map((t) => t.v)).toEqual(['+added']);
    expect(toks.filter((t) => t.t === 'del').map((t) => t.v)).toEqual(['-removed']);
  });
});
