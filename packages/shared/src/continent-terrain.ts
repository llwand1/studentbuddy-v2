/**
 * shared/continent-terrain — 知识大陆的**地貌生成**（纯函数、零随机、按世界种子确定）。
 *
 * ★ 为什么不再按「领域」给地砖上色：领域色是按词条散列落格的，相邻两格毫无关系 ⇒ 满图像拼豆。
 *   地貌改由**三张分形值噪声**（海拔 / 湿度 / 温度）决定，相邻格的噪声值连续 ⇒ 自然成片：
 *   海 → 浅滩 → 沙岸 → 草原 / 花甸 → 森林 → 沼泽，高处是丘陵、雪原与山峰。
 * ★ 出生点保护：离原点 3 格以内把海拔抬到陆地、压到山下（开局不会落在海里或山顶）。
 * ★ 同一颗种子任何时候、任何端算出同一张地貌（server 校验与 web 绘制共用）。
 */
import { continentHash } from './continent.js';

export type Biome =
  | 'deep'
  | 'shallow'
  | 'sand'
  | 'grass'
  | 'meadow'
  | 'forest'
  | 'swamp'
  | 'desert'
  | 'hill'
  | 'snow'
  | 'mountain';

export const BIOMES: readonly Biome[] = ['deep', 'shallow', 'sand', 'grass', 'meadow', 'forest', 'swamp', 'desert', 'hill', 'snow', 'mountain'];

export const BIOME_LABEL: Record<Biome, string> = {
  deep: '深海',
  shallow: '浅滩',
  sand: '沙岸',
  grass: '草原',
  meadow: '花甸',
  forest: '森林',
  swamp: '沼泽',
  desert: '荒漠',
  hill: '丘陵',
  snow: '雪原',
  mountain: '山岭',
};

/** 格点上的伪随机值 [0,1)（整数格 + 通道 ⇒ 稳定哈希） */
/**
 * 稳定哈希 + murmur3 终混（avalanche）。
 * ★ FNV-1a 对「只差最后一个字符」的输入只改低位（高位几乎不动）⇒ 直接拿它排序或除 2³²
 *   会出现整行相同的条纹、刷怪点总挤在同一边。凡是要「看起来随机」的地方一律用这个。
 */
export function mixHash(text: string): number {
  let h = continentHash(text);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function lattice(seed: number, ch: number, x: number, y: number): number {
  return mixHash(`${seed}|${ch}|${x}|${y}`) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 单层值噪声（双线性 + smoothstep） */
function valueNoise(seed: number, ch: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const a = lattice(seed, ch, x0, y0);
  const b = lattice(seed, ch, x0 + 1, y0);
  const c = lattice(seed, ch, x0, y0 + 1);
  const d = lattice(seed, ch, x0 + 1, y0 + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** 分形噪声：3 个倍频叠加，归一到 [0,1] */
export function fractalNoise(seed: number, ch: number, x: number, y: number, scale: number): number {
  let amp = 1;
  let freq = 1 / scale;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < 3; o += 1) {
    sum += valueNoise(seed, ch * 7 + o, x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

export interface TerrainSample {
  biome: Biome;
  /** 海拔 0~1（渲染用来画高差阴影） */
  elev: number;
  moist: number;
}

const cache = new Map<string, TerrainSample>();

/** 某格的地貌。★ 结果带缓存（纯函数，缓存只是省算力） */
export function terrainAt(seed: number, row: number, col: number): TerrainSample {
  const key = `${seed}|${row}|${col}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // 多层噪声叠加后会向 0.5 收拢，拉伸一下对比度，才分得出海、原、山
  const stretch = (v: number): number => Math.min(Math.max((v - 0.5) * 1.7 + 0.5, 0), 1);
  let e = fractalNoise(seed, 1, col, row, 9);
  const m = stretch(fractalNoise(seed, 2, col, row, 11));
  const t = fractalNoise(seed, 3, col, row, 16) * 0.7 + 0.3 * (1 - Math.min(Math.abs(row) / 40, 1));
  // 大尺度起伏：让海与山成大块，而不是一格一个
  e = stretch(e * 0.7 + fractalNoise(seed, 4, col, row, 26) * 0.3);
  const d = Math.abs(row) + Math.abs(col);
  if (d <= 3) e = Math.min(Math.max(e, 0.5), 0.62);
  else if (d <= 5) e = Math.max(e, 0.44);
  let biome: Biome;
  if (e < 0.3) biome = 'deep';
  else if (e < 0.37) biome = 'shallow';
  else if (e < 0.42) biome = 'sand';
  else if (e > 0.8) biome = 'mountain';
  else if (e > 0.7) biome = t < 0.45 ? 'snow' : 'hill';
  else if (m < 0.34) biome = t > 0.55 ? 'desert' : 'meadow';
  else if (m < 0.5) biome = 'grass';
  else if (m < 0.68) biome = 'forest';
  else biome = 'swamp';
  const out = { biome, elev: e, moist: m };
  if (cache.size > 40000) cache.clear();
  cache.set(key, out);
  return out;
}

/** 怪能不能在这种地貌上刷出来（深海不刷） */
export function biomeSpawns(b: Biome): boolean {
  return b !== 'deep';
}
