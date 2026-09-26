/**
 * routes/speech 端到端（supertest，同 answer-style.test.ts 手法）。
 *
 * 钉五件事：① 未配置回默认；② 读写一致且**真落库**（不是只在响应里演一遍）；
 * ③ 非法入参归一后回读（不 400、不落脏值）；④ ★★ `voiceName` **不做白名单**
 * （候选是本机装的语音包，服务端数不出来 ⇒ 不能因为「不认识」就清掉用户的设置）；
 * ⑤ 写接口吃同一道 Origin 闸门。
 *
 * ★ 另钉两条**反向**边界，防后人照抄别的设置卡时走偏：
 *   · 本域**没有** `configured` 两态（默认值即可用、不问不弹）⇒ 断言响应体**不含**该字段
 *     ——不造没有消费方的开关量；
 *   · 库里是坏 JSON 时读回默认（数据容错），且**不抛错**。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { boot, TEST_ORIGIN } from '../testing/http.js';
import { DEFAULT_SPEECH_SETTINGS, SETTING_KEY_SPEECH } from '@sb/shared';
import type { SpeechSettings } from '@sb/shared';

const { app, request, getDb, closeDb } = await boot('speech-test');
const origin = TEST_ORIGIN;

const get = () => request(app).get('/api/settings/speech');
const put = (body: Record<string, unknown>) =>
  request(app).put('/api/settings/speech').set('Origin', origin).send(body);
const del = () => request(app).delete('/api/settings/speech').set('Origin', origin);

function rawRow(): { value: string } | undefined {
  return getDb()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(SETTING_KEY_SPEECH) as { value: string } | undefined;
}

/** 取库里那一行；拿不到就抛（测试禁 `!` 非空断言，改用会抛错的辅助） */
function mustRow(): { value: string } {
  const row = rawRow();
  if (!row) throw new Error('app_settings 里没有 speech 行');
  return row;
}

beforeEach(() => {
  getDb().prepare('DELETE FROM app_settings WHERE key = ?').run(SETTING_KEY_SPEECH);
});

afterAll(() => closeDb());

describe('/api/settings/speech（词条朗读设置）', () => {
  it('未配置过 → 默认设置（空音色 + 1.0×＝本功能引入前的行为）', async () => {
    const res = await get().expect(200);
    expect(res.body.settings).toEqual(DEFAULT_SPEECH_SETTINGS);
  });

  it('★ 响应体不含 configured（本域没有「配过没有」两态，不造没有消费方的开关量）', async () => {
    const res = await get().expect(200);
    expect(res.body).not.toHaveProperty('configured');
    const putRes = await put({ settings: { rate: 1.5 } }).expect(200);
    expect(putRes.body).not.toHaveProperty('configured');
  });

  it('PUT 音色 + 语速 → 回读一致，且真落库', async () => {
    const mine: SpeechSettings = { voiceName: 'Microsoft David - English (United States)', rate: 1.5 };
    const putRes = await put({ settings: mine }).expect(200);
    expect(putRes.body.settings).toEqual(mine);

    const got = await get().expect(200);
    expect(got.body.settings).toEqual(mine);
    expect(JSON.parse(mustRow().value)).toEqual(mine);
  });

  it('★★ 任意音色名照存（服务端不做白名单：候选是「这台机器装了什么语音包」，它数不出来）', async () => {
    const name = '一台再也不会出现的机器上的音色';
    const res = await put({ settings: { voiceName: name, rate: 1 } }).expect(200);
    expect(res.body.settings.voiceName).toBe(name);
  });

  it('非法值 → 归一后回读，不 400 也不落脏值', async () => {
    const res = await put({ settings: { voiceName: 42, rate: 99 } }).expect(200);
    expect(res.body.settings).toEqual({ voiceName: '', rate: 2 });
    expect(JSON.parse(mustRow().value)).toEqual(res.body.settings);
  });

  it('body 里根本没有 settings → 全默认落库（PUT 语义是「存我给的」）', async () => {
    const res = await put({}).expect(200);
    expect(res.body.settings).toEqual(DEFAULT_SPEECH_SETTINGS);
  });

  it('库里是坏 JSON → 读回默认，且不抛错（数据容错）', async () => {
    getDb()
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
      .run(SETTING_KEY_SPEECH, '{"rate":');
    const res = await get().expect(200);
    expect(res.body.settings).toEqual(DEFAULT_SPEECH_SETTINGS);
  });

  it('DELETE → 回到默认设置，且真删键（不是写回默认值）', async () => {
    await put({ settings: { voiceName: 'David', rate: 1.5 } }).expect(200);
    const res = await del().expect(200);
    expect(res.body.settings).toEqual(DEFAULT_SPEECH_SETTINGS);
    expect(rawRow()).toBeUndefined();
  });

  it('写操作无 Origin → 403（与其余设置接口同一道闸门）', async () => {
    await request(app).put('/api/settings/speech').send({ settings: {} }).expect(403);
    await request(app).delete('/api/settings/speech').expect(403);
  });
});
