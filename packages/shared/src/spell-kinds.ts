/**
 * spell-kinds — 魔法吟唱的「款式」口径（契约 docs/SPELL-CHANT-SPEC.md §3.4）。
 *
 * ★ 一道咒语不止一种打法：每次吟唱开始时**掷一次骰**决定它释放时化作哪一款——五款画面完全不同
 *   （黑幕白刃 / 天光荆棘 / 月下枫叶 / 翠风旋刃 / 火蛇炸裂），但**款式只改画面，不改数值**：
 *   打多少仍由 `chantPower` / `spellDamage` 说了算，任何款式都不会多一点或少一点。
 * ★ 时长与命中帧写死在这张表里，DOM（伤害数字、卡片震动、结算切换）与 canvas 编排**同用这一份**，
 *   两边才不会各自数各自的毫秒。
 * ★ 掷骰通过 `rng` 注入：默认 `Math.random`，测试与截图脚本可以传固定函数指定款式。
 */
export const SPELL_KINDS = ['dusk', 'grace', 'leaf', 'sylph', 'salamander'] as const;
export type SpellKind = (typeof SPELL_KINDS)[number];

export interface SpellKindMeta {
  id: SpellKind;
  /** 招式名（吟唱框标签、结算句、地图横幅都用它） */
  name: string;
  /** 一句画面描述（结算句 / 图鉴口吻） */
  blurb: string;
  /** 释放动画总时长（ms） */
  durationMs: number;
  /** 命中帧（ms）：伤害数字弹出、卡片震动、怪受击白闪都对齐到它 */
  impactMs: number;
}

export const SPELL_KIND_META: Record<SpellKind, SpellKindMeta> = {
  dusk: { id: 'dusk', name: '无光斩', blurb: '黑幕吞没四野，一记白刃十字劈开', durationMs: 1600, impactMs: 560 },
  grace: { id: 'grace', name: '悔罪光柱', blurb: '天光垂落，荆棘自地而生，蓝焰绕柱', durationMs: 1900, impactMs: 560 },
  leaf: { id: 'leaf', name: '月下叶舞', blurb: '新月当空，枫叶旋成一圈后炸开', durationMs: 1800, impactMs: 640 },
  sylph: { id: 'sylph', name: '风灵旋刃', blurb: '翠风卷成龙卷，三道风刃穿过', durationMs: 1700, impactMs: 600 },
  salamander: { id: 'salamander', name: '炎蛇', blurb: '火蛇盘绕三匝，一口咬下炸成火球', durationMs: 1800, impactMs: 620 },
};

/** 掷骰：`rng` 返回 [0,1)；越界值钳到两端（rng 不合规也不许掷出不存在的款式） */
export function pickSpellKind(rng: () => number = Math.random): SpellKind {
  const i = Math.floor(rng() * SPELL_KINDS.length);
  return SPELL_KINDS[Math.max(0, Math.min(SPELL_KINDS.length - 1, i))] ?? 'dusk';
}

export function spellKindMeta(kind: SpellKind): SpellKindMeta {
  return SPELL_KIND_META[kind];
}

/** 是不是合法款式（跨端传输 / 旧数据兜底用） */
export function isSpellKind(v: unknown): v is SpellKind {
  return typeof v === 'string' && (SPELL_KINDS as readonly string[]).includes(v);
}
