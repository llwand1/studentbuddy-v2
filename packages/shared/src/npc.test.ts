/**
 * shared/npc.test — 学习伙伴（NPC）的跨端口径锁（契约 `docs/NPC-PARTNER-SPEC.md` §2/§5）。
 *
 * ★ 本文件锁的是三件"两处各算一遍就会互相打脸"的事：
 *   ① **花名册容错解析**（`parseNpcParty`）：坏 JSON／缺字段／重复格都要跳过而不抛，
 *      否则一个脏字节会让整张花名册消失（或涌现出没有坐标的幽灵伙伴）；
 *   ② **名额与门票两条纯公式**（`npcCapFor` / `npcTasksRequiredFor`）：它们决定"能不能再创建一位"，
 *      算错了要么把用户挡在门外，要么让位子白送；
 *   ③ **遇险半径 = 正相邻**（与 `canStrike` 同判断标准）——放宽到 2 会出现"他说被围住了，我却够不着"。
 *      ★ **距离 0 也是合法威胁**（怪压在他那一格上＝地被夺走了），故这里专门锁一条。
 * ★ 零随机的判断标准（`npcNameFromPool` / `npcFallbackLine`）也在这里：名字一旦随机，刷新一次就换人。
 */
import { describe, expect, it } from 'vitest';
import {
  NPC_BIO_MAX,
  NPC_DANGER_RANGE,
  NPC_MAX_CAP,
  NPC_MAX_MIN,
  NPC_NAME_MAX,
  NPC_NAME_POOL,
  NPC_TASKS_PER_PARTNER,
  NPC_TRADES_PER_DAY,
  npcCapFor,
  npcDistress,
  npcFallbackLine,
  npcIdOf,
  npcNameFromPool,
  npcRescueDedupeKey,
  npcTasksRequiredFor,
  npcTemplateBio,
  npcTradesLeft,
  normalizeNpcBio,
  normalizeNpcName,
  parseNpcParty,
  NPC_JOBS,
  npcJobOf,
  npcMoodOf,
  type NpcMonster,
} from './npc.js';
// ★ 世界口径在 continent.ts（名额上限跟着它涨）——从那里引，不从 npc.ts 转出
import { WORLD_MAX_RADIUS, WORLD_MIN_RADIUS, worldRadiusFor } from './continent.js';

const member = (termId: string, row: number, col: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: `npc:${termId}`, name: `名-${termId}`, bio: '守着它', termId, row, col, ...extra });

const party = (...members: string[]): string => `{"members":[${members.join(',')}]}`;

describe('npcCapFor — 名额上限跟世界半径涨（下限 6、硬上限 24）', () => {
  it('① 边界：小世界 6、本机 327 条的世界 9、半径封顶时 24', () => {
    expect(npcCapFor(WORLD_MIN_RADIUS)).toBe(NPC_MAX_MIN); // 225 格 ⇒ 落到下限 6
    expect(npcCapFor(9)).toBe(9); // ★ 361 格（本机 327 条词条的世界）⇒ 9 位
    expect(npcCapFor(WORLD_MAX_RADIUS)).toBe(NPC_MAX_CAP);
    expect(worldRadiusFor(327)).toBe(9); // 与上一条同源：上限不可能与地图大小打架
  });

  it('①b 脏输入不炸：负数 / 小数 / NaN 一律落到下限', () => {
    expect(npcCapFor(-5)).toBe(NPC_MAX_MIN);
    expect(npcCapFor(0)).toBe(NPC_MAX_MIN);
    expect(npcCapFor(Number.NaN)).toBe(NPC_MAX_MIN);
  });
});

describe('npcTasksRequiredFor — 创建第 N 位的门票（第 1 位无条件）', () => {
  it('② 第 1 位 0 单、第 2 位 3 单、第 3 位 6 单（每多一位多 3 单）', () => {
    expect(NPC_TASKS_PER_PARTNER).toBe(3);
    expect(npcTasksRequiredFor(1)).toBe(0);
    expect(npcTasksRequiredFor(2)).toBe(3);
    expect(npcTasksRequiredFor(3)).toBe(6);
    expect(npcTasksRequiredFor(9)).toBe(24);
  });

  it('②b 脏输入同样不炸：0 / 负数 / NaN / 小数都落到"第 1 位"（无条件，不把门锁死）', () => {
    expect(npcTasksRequiredFor(0)).toBe(0);
    expect(npcTasksRequiredFor(-4)).toBe(0);
    expect(npcTasksRequiredFor(Number.NaN)).toBe(0);
    expect(npcTasksRequiredFor(2.9)).toBe(3); // 截断成 2 位
    expect(npcTasksRequiredFor(1.9)).toBe(0); // 截断成 1 位
  });
});

describe('parseNpcParty — 花名册容错解析（坏字节不许毁掉整张名册）', () => {
  it('③ 正常解析：字段齐全并归一化名字', () => {
    const got = parseNpcParty(party(member('t1', 5, 7, { name: '  小白  ' })));
    expect(got).toEqual([
      { id: 'npc:t1', name: '小白', bio: '守着它', termId: 't1', row: 5, col: 7, job: npcJobOf({ termId: 't1' }), mood: npcMoodOf({ termId: 't1' }) },
    ]);
  });

  it('③d 职业与性格：合法值原样保留，缺失/非法按 termId 给稳定默认（旧名册升级后不换人设）', () => {
    const got = parseNpcParty(party(member('t2', 1, 1, { job: 'knight', mood: 'snark' }), member('t3', 2, 2, { job: 'pirate' })));
    expect(got[0]).toMatchObject({ job: 'knight', mood: 'snark' });
    expect(NPC_JOBS).toContain(got[1]!.job);
    expect(got[1]!.job).toBe(npcJobOf({ termId: 't3' }));
    expect(parseNpcParty(party(member('t3', 2, 2)))[0]!.mood).toBe(got[1]!.mood);
  });

  it('③b 坏 JSON / 非对象 / members 不是数组 ⇒ 一律空数组，不抛', () => {
    expect(parseNpcParty('not-json{')).toEqual([]);
    expect(parseNpcParty('')).toEqual([]);
    expect(parseNpcParty('[]')).toEqual([]);
    expect(parseNpcParty('{"members":{}}')).toEqual([]);
    expect(parseNpcParty('{"members":[]}')).toEqual([]);
  });

  it('③c 坏条目逐条跳过：缺 termId／名字空／坐标不是有限数／id 与坐标重复', () => {
    const raw = party(
      member('t1', 0, 0),
      JSON.stringify({ name: '没锚点', row: 1, col: 1 }),
      member('t2', 1, 2, { name: '   ' }),
      member('t3', 2, 3, { row: 'x', col: 3 }),
      member('t1', 9, 9), // 同一条词条（id 撞）⇒ 丢
      member('t4', 0, 0), // 同一格（坐标撞）⇒ 丢
    );
    const got = parseNpcParty(raw);
    expect(got.map((m) => m.termId)).toEqual(['t1']);
  });

  it('③d 缺 id 时按 `npc:<termId>` 补齐；bio 缺失 ⇒ 空串；条数封顶 `NPC_MAX_CAP`', () => {
    const noId = parseNpcParty(party(JSON.stringify({ name: '无 id', termId: 'tx', row: 3, col: 3 })));
    expect(noId[0]?.id).toBe('npc:tx');
    expect(noId[0]?.bio).toBe('');
    const many = Array.from({ length: NPC_MAX_CAP + 5 }, (_, i) => member(`t${i}`, i, i));
    expect(parseNpcParty(party(...many))).toHaveLength(NPC_MAX_CAP);
  });
});

describe('名字与人设：归一化、本地兜底（全是零随机）', () => {
  it('④ 名字按码点截到 12 字、去控制符；人设截到 40 字', () => {
    expect(normalizeNpcName('  小 白  ')).toBe('小 白');
    expect(normalizeNpcName('一二三四五六七八九十十一十二十三')).toHaveLength(NPC_NAME_MAX);
    expect(normalizeNpcName('   ')).toBe('');
    expect(normalizeNpcBio('一'.repeat(200))).toHaveLength(NPC_BIO_MAX);
    expect(normalizeNpcBio('长'.repeat(99)).endsWith('…')).toBe(false); // 只截不补字符，不伪造省略号
  });

  it('④b 本地兜底名字取自名字池且确定性（同一条词条任何端同名）', () => {
    expect(NPC_NAME_POOL).toContain(npcNameFromPool('t1'));
    expect(npcNameFromPool('t1')).toBe(npcNameFromPool('t1'));
    expect(npcNameFromPool('t2').length).toBeGreaterThan(0);
  });

  it('④c 本地兜底人设带**他守的那条词条**、不编造用户进度、长度合规', () => {
    const bio = npcTemplateBio('主动回忆');
    expect(bio).toContain('主动回忆');
    expect(bio.length).toBeLessThanOrEqual(NPC_BIO_MAX);
    expect(bio).not.toMatch(/\d/); // 任何数字都意味着偷偷编了进度
    expect(npcTemplateBio('   ')).not.toContain('「」'); // 词条名缺失时不留空引号
  });
});

describe('npcDistress — 正相邻（含距离 0）的怪才算威胁', () => {
  const npc = { row: 5, col: 5 };
  const body = (termId: string, row: number, col: number): NpcMonster => ({
    termId,
    term: `怪-${termId}`,
    row,
    col,
  });

  it('⑤ 曼哈顿 ≤1 才给威胁；斜对角（距离 2）不算', () => {
    expect(npcDistress(npc, [body('m1', 5, 6)])).toEqual({ termId: 'm1', term: '怪-m1', distance: 1 });
    expect(npcDistress(npc, [body('m1', 4, 6)])).toBeNull();
    expect(npcDistress(npc, [])).toBeNull();
    expect(NPC_DANGER_RANGE).toBe(1);
  });

  it('⑤b ★ 距离 0 也是威胁：怪正好压在他那一格上（"地被夺走了"）', () => {
    expect(npcDistress(npc, [body('m1', 5, 5)])?.distance).toBe(0);
    // ★ 距离 0 比距离 1 更近 ⇒ 两者都在时取 0 那只
    expect(npcDistress(npc, [body('m1', 5, 6), body('m2', 5, 5)])?.termId).toBe('m2');
  });

  it('⑤c 多只怪时取最近的；同距按 termId 升序（确定性）', () => {
    const near = npcDistress(npc, [body('m2', 5, 6), body('m1', 4, 5), body('m3', 9, 9)]);
    expect(near?.distance).toBe(1);
    expect(near?.termId).toBe('m1');
  });
});

describe('键与读数', () => {
  it('⑥ 求救单去重键不含会变的数：同一位伙伴恒同一键', () => {
    expect(npcRescueDedupeKey(npcIdOf('t1'))).toBe('npc_rescue:npc:t1');
    expect(npcRescueDedupeKey(npcIdOf('t1'))).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{10,}/);
  });

  it('⑥b 每日交换余额夹在 0 与上限之间', () => {
    expect(npcTradesLeft(0)).toBe(NPC_TRADES_PER_DAY);
    expect(npcTradesLeft(NPC_TRADES_PER_DAY)).toBe(0);
    expect(npcTradesLeft(99)).toBe(0);
    expect(npcTradesLeft(-3)).toBe(NPC_TRADES_PER_DAY);
  });

  it('⑥c 降级台词：永不空回，替换词条名，且确定性', () => {
    const line = npcFallbackLine(npcIdOf('t1'), 0, '主动回忆');
    expect(line).toContain('主动回忆');
    expect(line).toBe(npcFallbackLine(npcIdOf('t1'), 0, '主动回忆'));
    // 词条名缺失时退成一句通用话，不留 `「」` 空引号
    expect(npcFallbackLine(npcIdOf('t2'), 1, '   ')).not.toContain('「」');
  });
});