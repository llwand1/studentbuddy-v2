/**
 * shared/spell-kinds.test — 魔法吟唱「款式」口径锁（契约 `docs/SPELL-CHANT-SPEC.md` §3.4）。
 *
 * ★ 锁三件事：① 五款各异、名字不重、元数据齐全（时长 > 命中帧 > 0，全部压在 2 秒预算内）；
 *   ② 掷骰**只看注入的 rng**、越界值不掷出不存在的款式（画面层拿到 undefined 就是一帧黑屏）；
 *   ③ `isSpellKind` 只认表里的 id——跨端传个 `'fire'` 过来不能混进 canvas 的分派表。
 */
import { describe, expect, it } from 'vitest';
import { SPELL_KINDS, SPELL_KIND_META, isSpellKind, pickSpellKind, spellKindMeta } from './spell-kinds.js';

describe('SPELL_KINDS / SPELL_KIND_META：五款各异', () => {
  it('五款 id 与招式名互不重复，元数据 id 回指自身', () => {
    expect(SPELL_KINDS).toHaveLength(5);
    expect(new Set(SPELL_KINDS).size).toBe(5);
    const names = SPELL_KINDS.map((k) => SPELL_KIND_META[k].name);
    expect(new Set(names).size).toBe(5);
    for (const k of SPELL_KINDS) {
      expect(SPELL_KIND_META[k].id).toBe(k);
      expect(spellKindMeta(k)).toBe(SPELL_KIND_META[k]);
      expect(SPELL_KIND_META[k].name.length).toBeGreaterThanOrEqual(2);
      expect(SPELL_KIND_META[k].blurb.length).toBeGreaterThan(4);
    }
  });

  it('时长 > 命中帧 > 0，且整段释放压在 2 秒预算内', () => {
    for (const k of SPELL_KINDS) {
      const m = SPELL_KIND_META[k];
      expect(m.impactMs).toBeGreaterThan(0);
      expect(m.durationMs).toBeGreaterThan(m.impactMs);
      expect(m.durationMs).toBeLessThanOrEqual(2000);
    }
  });
});

describe('pickSpellKind：掷骰只看 rng', () => {
  it('rng 均匀切五段，每段落到一款；边界 0 与 0.999 分别是首尾', () => {
    expect(pickSpellKind(() => 0)).toBe('dusk');
    expect(pickSpellKind(() => 0.999)).toBe('salamander');
    const seen = new Set(Array.from({ length: 5 }, (_, i) => pickSpellKind(() => (i + 0.5) / 5)));
    expect(seen.size).toBe(5);
  });

  it('越界 / 脏 rng 钳到两端，不掷出不存在的款式', () => {
    expect(pickSpellKind(() => 1)).toBe('salamander');
    expect(pickSpellKind(() => 7)).toBe('salamander');
    expect(pickSpellKind(() => -3)).toBe('dusk');
    expect(SPELL_KINDS).toContain(pickSpellKind());
  });
});

describe('isSpellKind', () => {
  it('只认表里的 id', () => {
    for (const k of SPELL_KINDS) expect(isSpellKind(k)).toBe(true);
    expect(isSpellKind('fire')).toBe(false);
    expect(isSpellKind(undefined)).toBe(false);
    expect(isSpellKind(3)).toBe(false);
  });
});
