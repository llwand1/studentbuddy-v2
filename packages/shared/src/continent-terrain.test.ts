/** continent-terrain.test — 地形算法锁：确定性、多地貌、成片（不是「拼豆」）、无条纹。 */
import { describe, it, expect } from 'vitest';
import { BIOMES, mixHash, terrainAt } from './index.js';

function grid(seed: number, n = 40) {
  const out: string[][] = [];
  for (let r = -n / 2; r < n / 2; r++) {
    const row: string[] = [];
    for (let c = -n / 2; c < n / 2; c++) row.push(terrainAt(seed, r, c).biome);
    out.push(row);
  }
  return out;
}

describe('terrainAt', () => {
  it('确定性：同种子同格同结果', () => {
    expect(terrainAt(7, 3, -4)).toEqual(terrainAt(7, 3, -4));
  });

  it('多地貌：大范围里至少出现 5 种，且都是合法地貌', () => {
    const seen = new Set<string>();
    for (let r = -60; r < 60; r += 2) for (let c = -60; c < 60; c += 2) seen.add(terrainAt(3, r, c).biome);
    expect(seen.size).toBeGreaterThanOrEqual(5);
    for (const b of seen) expect(BIOMES).toContain(b);
  });

  it('★ 成片：相邻格同地貌的比例远高于随机（拼豆 ≈ 1/11）', () => {
    for (const seed of [1, 2, 3]) {
      const g = grid(seed);
      let same = 0, all = 0;
      for (let r = 0; r < g.length; r++) for (let c = 0; c + 1 < g.length; c++) { all++; if (g[r]![c] === g[r]![c + 1]) same++; }
      expect(same / all).toBeGreaterThan(0.55);
    }
  });

  it('★ 出生点附近是可站的陆地（不出生在海里）', () => {
    for (const seed of [1, 5, 9, 42]) {
      const b = terrainAt(seed, 0, 0).biome;
      expect(['deep', 'shallow', 'mountain']).not.toContain(b);
    }
  });

  it('★ mixHash 低位均匀：只差末位的输入不产生条纹（按行取模分布平衡）', () => {
    const buckets = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i++) buckets[mixHash(`s|${i}`) % 4]! += 1;
    for (const b of buckets) expect(b).toBeGreaterThan(850);
    // 相邻行（只差最后一个字符）的高位不应相关
    let eq = 0;
    for (let r = 0; r < 200; r++) if ((mixHash(`7|${r},0`) >>> 28) === (mixHash(`7|${r + 1},0`) >>> 28)) eq++;
    expect(eq).toBeLessThan(40);
  });
});
