/**
 * guide-copy 单测：界面框架文案中英成对，不留半成品（同 `shell-copy` 那把「遍历全表」的锁）。
 * 组件里不留中文字面量 ⇒ 漏译只会出现在这张表里；这里一条锁遍历全表，空串 / 缺语言 / 中英相同（没译）都红。
 */
import { describe, expect, it } from 'vitest';
import { GUIDE_COPY, GUIDE_REASON_COPY } from './guide-copy';

describe('GUIDE_COPY 与 GUIDE_REASON_COPY', () => {
  const all = [...Object.entries(GUIDE_COPY), ...Object.entries(GUIDE_REASON_COPY)];

  it('每条都有非空的中文与英文', () => {
    for (const [key, bi] of all) {
      expect(bi.zh.trim(), `${key}.zh`).not.toBe('');
      expect(bi.en.trim(), `${key}.en`).not.toBe('');
    }
  });

  it('中英不相同（相同＝没译；个别纯符号条目除外，这里没有）', () => {
    for (const [key, bi] of all) expect(bi.zh, key).not.toBe(bi.en);
  });

  it('机器码原因全覆盖：no-model / timeout / aborted / upstream / parse + 客户端自己的 failed', () => {
    expect(Object.keys(GUIDE_REASON_COPY).sort()).toEqual(['aborted', 'failed', 'no-model', 'parse', 'timeout', 'upstream']);
  });
});
