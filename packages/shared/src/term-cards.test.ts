import { describe, it, expect } from 'vitest';
import {
  starOf,
  cardsForStar,
  nextStarProgress,
  rarityOf,
  RARITY_MIN_CARDS,
  CARD_STAR_CAP,
  FREE_OPENS_PER_DAY,
  DAILY_OPEN_CAP,
  opensLeft,
  advanceDedupeKey,
  poolDedupeKey,
  cardsChannel,
} from './term-cards.js';

// 契约 docs/TERM-CARDS-SPEC.md §2：曲线与稀有度的唯一实现。
// ★ 这批用例锁的是**判据**而不是数值巧合——改曲线的人第一件事就是"顺手把测试期望换掉"，
//   所以每条都写明"为什么是这个数"。

describe('shared/term-cards — 指数曲线（老板 2026-09-25 对线性方案的改判）', () => {
  it('★n 需要 2^n 张：★1=2、★2=4、★3=8、★4=16、★8=256', () => {
    // 「3 星就是要 8 次」是原话，★3 这个数单独钉死
    expect(cardsForStar(1)).toBe(2);
    expect(cardsForStar(2)).toBe(4);
    expect(cardsForStar(3)).toBe(8);
    expect(cardsForStar(4)).toBe(16);
    expect(cardsForStar(CARD_STAR_CAP)).toBe(256);
  });

  it('卡数 → 星级：区间下沿进位、上沿不进位', () => {
    expect(starOf(1)).toBe(0);
    expect(starOf(2)).toBe(1);
    expect(starOf(3)).toBe(1); // 3 张不够 ★2
    expect(starOf(4)).toBe(2);
    expect(starOf(7)).toBe(2);
    expect(starOf(8)).toBe(3);
    expect(starOf(256)).toBe(8);
  });

  it('★ 封顶存在：257 张与一亿张都停在 ★8（不封顶会把负/无穷带到 UI 数组下标）', () => {
    expect(starOf(257)).toBe(CARD_STAR_CAP);
    expect(starOf(1e9)).toBe(CARD_STAR_CAP);
  });

  it('★ 退化输入不出 NaN / -Infinity（log2(0) = -Infinity 会一路穿到 Array.from 抛 RangeError）', () => {
    expect(starOf(0)).toBe(0);
    expect(starOf(-5)).toBe(0);
    expect(starOf(Number.NaN)).toBe(0);
    expect(starOf(1.7)).toBe(0); // 小数截断，不四舍五入
    expect(nextStarProgress(0).star).toBe(0);
    expect(Number.isFinite(nextStarProgress(0).pct)).toBe(true);
  });

  it('★ 互逆性是这条曲线的承重墙：starOf(cardsForStar(n)) === n（初稿就是在这里自相矛盾）', () => {
    for (let n = 1; n <= CARD_STAR_CAP; n++) {
      expect(starOf(cardsForStar(n))).toBe(n);
      // 门槛前一张必然还停在上一星——否则"升星"这件事没有确定的时刻
      expect(starOf(cardsForStar(n) - 1)).toBe(n - 1);
    }
  });
});

describe('shared/term-cards — 距下一星', () => {
  it('★0→★1 的跨度按"已有 1 张起步"算，不把 0～1 那段空白算成进度', () => {
    const p = nextStarProgress(1);
    expect(p.nextStar).toBe(1);
    expect(p.needed).toBe(1);
    expect(p.pct).toBe(0);
    expect(nextStarProgress(2).pct).toBe(0); // 刚升上 ★1，下一段从 0 开始
    expect(nextStarProgress(3).pct).toBe(0.5); // ★1→★2 跨 2 张，已走 1 张
  });

  it('封顶时 needed / nextStar 为 null（UI 据此说"已满星"而不是"还差 0 张"）', () => {
    const p = nextStarProgress(256);
    expect(p.star).toBe(CARD_STAR_CAP);
    expect(p.nextStar).toBeNull();
    expect(p.needed).toBeNull();
    expect(p.pct).toBe(1);
  });
});

describe('shared/term-cards — 稀有度按卡数分档（★ 不按星级，契约 §2 口径 2）', () => {
  it('1 张 N、2 张 R、4 张 SR、8 张起 SSR', () => {
    expect(rarityOf(1)).toBe('N');
    expect(rarityOf(RARITY_MIN_CARDS.R)).toBe('R');
    expect(rarityOf(3)).toBe('R');
    expect(rarityOf(RARITY_MIN_CARDS.SR)).toBe('SR');
    expect(rarityOf(7)).toBe('SR');
    expect(rarityOf(RARITY_MIN_CARDS.SSR)).toBe('SSR');
    expect(rarityOf(9999)).toBe('SSR');
  });

  it('★ 判据本身：库里绝大多数词条停在 ★0～★1，按星分档会把它们挤成同一档', () => {
    // demo 实测：日均提及 1～3 次时全库 80% 是 ★0。按星分档 ⇒ 这些全是 N、毫无观感；
    // 按卡分档 ⇒ 攒到 2 张就有 R。**这条测试是"让指数曲线活得下来"的那一环。**
    const realisticDailyMentions = [1, 1, 2, 2, 3]; // cards = 提及 + 复习日 + 1
    const rarities = realisticDailyMentions.map((m) => rarityOf(m + 1));
    expect(rarities.filter((r) => r !== 'N').length).toBeGreaterThan(0);
    // 而同一批数按 starOf 分档会全落 ★0～★1 两档
    expect(new Set(realisticDailyMentions.map((m) => starOf(m + 1))).size).toBeLessThanOrEqual(2);
  });
});

describe('shared/term-cards — 宝箱钥匙（每日 3 + 赚钥匙 + 日上限）', () => {
  it('起页 3 次免费；开一次少一次', () => {
    expect(FREE_OPENS_PER_DAY).toBe(3);
    const fresh = { free_used: 0, earned_keys: 0, opened_today: 0 };
    expect(opensLeft(fresh)).toEqual({ left: 3, reason: 'ok' });
    expect(opensLeft({ ...fresh, free_used: 3 }).reason).toBe('exhausted');
  });

  it('完成一单 +1 把 earned，跨日不清零（囤积是玩家自由）', () => {
    const saved = { free_used: 0, earned_keys: 20, opened_today: 0 };
    expect(opensLeft(saved).left).toBeGreaterThan(FREE_OPENS_PER_DAY);
  });

  it('★ 但每日开盒硬上限生效：囤 20 把也开不满一天第二次"今天开满"', () => {
    const hoarded = { free_used: FREE_OPENS_PER_DAY, earned_keys: 20, opened_today: DAILY_OPEN_CAP };
    const r = opensLeft(hoarded);
    expect(r.left).toBe(0);
    // ★ reason 必须是 capped 不是 exhausted：两种 0 对用户的说法完全不同
    //   （「钥匙用完了，完成一单再加一次」vs「今天开满了，明天请早」）
    expect(r.reason).toBe('capped');
  });

  it('钥匙够但未达上限时，left 取两者较小值', () => {
    expect(opensLeft({ free_used: 3, earned_keys: 1, opened_today: 4 }).left).toBe(1);
    expect(opensLeft({ free_used: 0, earned_keys: 0, opened_today: 0 }).left).toBe(3);
  });
});

describe('shared/term-cards — 派单幂等键（★ 键里不得含会变的数字，契约 §5）', () => {
  it('推进类：键只到"目标星"这一层，进度百分比与剩余张数都不进键', () => {
    const k = advanceDedupeKey('t1', 3);
    expect(k).toBe('advance:t1:3');
    expect(k).not.toMatch(/\d+(\.\d+)?%/);
    // 同一意图的不同完成度 ⇒ 同一个键（这正是幂等所需）
    expect(advanceDedupeKey('t1', 3)).toBe(k);
    // 换了目标星 ⇒ 是另一件事，该派新单
    expect(advanceDedupeKey('t1', 4)).not.toBe(k);
  });

  it('★ 意图变了才换键：与 memory-digest 那条 user_memory UNIQUE 教训的分工写进断言', () => {
    // `pct` 每刷一次都不同（同一个意图的不同完成度）⇒ 进 `why` 文案
    // `targetStar` 不同则是另一件事（★2→★3 ≠ ★3→★4）⇒ 进键
    expect(advanceDedupeKey('t1', 2)).not.toBe(advanceDedupeKey('t1', 3));
  });

  it('目标星越界被钳进 [1, ★8]（负数/NaN 会拼出没人能匹配的键，导致同一意图反复派单）', () => {
    expect(advanceDedupeKey('t1', -3)).toBe('advance:t1:1');
    expect(advanceDedupeKey('t1', Number.NaN)).toBe('advance:t1:1');
    expect(advanceDedupeKey('t1', 99)).toBe(`advance:t1:${CARD_STAR_CAP}`);
  });

  it('补池类的键带领域（不同领域可以有同名词条，照 term_library 的 UNIQUE(owner,term,domain) 口径）', () => {
    expect(poolDedupeKey('闭包', 'cs')).toBe('pool:cs:闭包');
    expect(poolDedupeKey('闭包', 'math')).not.toBe(poolDedupeKey('闭包', 'cs'));
  });
});

describe('shared/term-cards — 频道键四向隔离', () => {
  it('cards: 前缀，且未登录落 local（与 coachChannel 同形状）', () => {
    expect(cardsChannel('u1')).toBe('cards:u1');
    expect(cardsChannel(null)).toBe('cards:local');
  });

  it('★ 不与聊天/PK/督促的同名键相撞：撞了 seq 就不可比，去重会大面积误丢帧（B-007）', () => {
    expect(cardsChannel('u1')).not.toBe(`coach:u1`);
    expect(cardsChannel('u1')).not.toBe(`pk:u1`);
    expect(cardsChannel('u1')).not.toBe('u1'); // 聊天频道＝裸 sessionId
  });
});
