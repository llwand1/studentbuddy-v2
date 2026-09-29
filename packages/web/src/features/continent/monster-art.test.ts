/**
 * monster-art.test — 「一种题型组合 = 一种怪」的外观口径。
 *
 * 锁三件事：
 *  ① **外观数 = 图鉴槽数**（155），且 155 种两两不同（像素图或调色板至少一处不同）——
 *     题型序列允许重复（`[判断, 判断]`），最容易与 `[判断]` 撞脸，故逐对比。
 *  ② 确定性：同一组合恒同一外观（缓存与否都一样）；俗名也随之确定。
 *  ③ 像素图是合法的 12×12（`drawSprite` 不校验，画歪了只会静默糊掉）。
 */
import { describe, expect, it } from 'vitest';
import { CONTINENT_CODEX_SLOTS, CONTINENT_PLAYABLE_QTYPES, codexSlotTypes, type ContinentQType } from '@sb/shared';
import { monsterLook, monsterLookCount } from './monster-art';

function signature(species: readonly ContinentQType[]): string {
  const look = monsterLook(species);
  return `${look.map.join('/')}|${JSON.stringify(look.pal)}`;
}

describe('monsterLook', () => {
  it('① 155 种外观与图鉴槽一一对应，且两两不同', () => {
    expect(monsterLookCount()).toBe(CONTINENT_CODEX_SLOTS);
    const seen = new Map<string, string>();
    for (let slot = 0; slot < CONTINENT_CODEX_SLOTS; slot += 1) {
      const species = codexSlotTypes(slot);
      const sig = signature(species);
      const clash = seen.get(sig);
      expect(clash, `槽 ${slot} (${species.join('+')}) 与 ${clash ?? ''} 撞脸`).toBeUndefined();
      seen.set(sig, species.join('+'));
    }
    expect(seen.size).toBe(CONTINENT_CODEX_SLOTS);
  });

  it('② 同一组合恒同一外观与俗名；饰物只在三型怪上；二型怪带「成体」', () => {
    expect(monsterLook(['judge', 'choice', 'fill'])).toEqual(monsterLook(['judge', 'choice', 'fill']));
    expect(monsterLook(['judge']).name).toBe('霜蓝史莱姆');
    expect(monsterLook(['judge', 'judge']).name).toBe('霜蓝史莱姆·成体');
    expect(monsterLook(['match', 'scene']).name).toBe('余烬蛇妖·成体');
    expect(monsterLook(['scene', 'judge', 'choice']).name).toBe('王冠·霜蓝幽魂');
    expect(monsterLook([]).name).toBe(monsterLook(['judge']).name); // 空序列兜底不抛
  });

  it('③ 每种体型都是 12 行 × 12 列，字母只用调色板里有的键', () => {
    for (let slot = 0; slot < CONTINENT_CODEX_SLOTS; slot += 1) {
      const look = monsterLook(codexSlotTypes(slot));
      expect(look.map).toHaveLength(12);
      for (const row of look.map) {
        expect(row).toHaveLength(12);
        for (const ch of row) expect(ch === '.' || ch in look.pal, `未知像素字母 ${ch}`).toBe(true);
      }
    }
    expect(CONTINENT_PLAYABLE_QTYPES).toHaveLength(5);
  });
});
