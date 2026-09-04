/**
 * routes/answer-style 端到端（supertest，同 quiz-image.test.ts 手法）。
 * 钉四件事：未配置回默认且 configured=false；读写一致且真落库；
 * 非法入参逐字段归一后回读（不 400、不落脏值）；写接口吃同一道 Origin 闸门。
 * ★ 另钉「库里脏 JSON 时 configured 仍为 true」——键在就是配过，不能因脏数据把用户重新问一遍。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ANSWER_STYLE, SETTING_KEY_ANSWER_STYLE } from '@sb/shared';
import type { AnswerStyle } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-answer-style-test-'));
const { app } = await import('../index.js');
const { closeDb, getDb } = await import('../storage/db.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';

const get = () => request(app).get('/api/settings/answer-style');
const put = (body: Record<string, unknown>) =>
  request(app).put('/api/settings/answer-style').set('Origin', origin).send(body);
const del = () => request(app).delete('/api/settings/answer-style').set('Origin', origin);

/** 绕过读写函数，直接看库里那一行（configured 的真值来源就是它） */
function rawRow(): { value: string } | undefined {
  return getDb()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(SETTING_KEY_ANSWER_STYLE) as { value: string } | undefined;
}

beforeEach(() => {
  getDb().prepare('DELETE FROM app_settings WHERE key = ?').run(SETTING_KEY_ANSWER_STYLE);
});

afterAll(() => closeDb());

describe('/api/settings/answer-style（回答方式偏好）', () => {
  it('未配置过 → 默认偏好 + configured=false（L1 据此决定要不要弹选项卡）', async () => {
    const res = await get().expect(200);
    expect(res.body.style).toEqual(DEFAULT_ANSWER_STYLE);
    expect(res.body.configured).toBe(false);
  });

  it('PUT 四维全改 → 回读一致，且真落库（不是只在响应里演一遍）', async () => {
    const mine: AnswerStyle = { verbosity: 'brief', tone: 'socratic', support: 'worked', shape: 'bullets' };
    const putRes = await put({ style: mine }).expect(200);
    expect(putRes.body.style).toEqual(mine);
    expect(putRes.body.configured).toBe(true);

    const got = await get().expect(200);
    expect(got.body.style).toEqual(mine);
    expect(got.body.configured).toBe(true);
    expect(JSON.parse(rawRow()!.value)).toEqual(mine);
  });

  it('存了恰好等于默认的值 → configured 仍为 true（配过与没配过是两件事）', async () => {
    await put({ style: DEFAULT_ANSWER_STYLE }).expect(200);
    const got = await get().expect(200);
    expect(got.body.style).toEqual(DEFAULT_ANSWER_STYLE);
    expect(got.body.configured).toBe(true);
  });

  it('非法值 / 缺字段 → 逐字段归一后回读，不 400 也不落脏值', async () => {
    const res = await put({ style: { verbosity: 'chatty', tone: 'peer', support: 42 } }).expect(200);
    expect(res.body.style).toEqual({
      ...DEFAULT_ANSWER_STYLE,
      tone: 'peer',
    });
    // 库里存的必须是归一后的干净值
    expect(JSON.parse(rawRow()!.value)).toEqual(res.body.style);
  });

  it('body 里根本没有 style → 全默认落库（PUT 语义是"存我给的"，不是"改我给的"）', async () => {
    const res = await put({}).expect(200);
    expect(res.body.style).toEqual(DEFAULT_ANSWER_STYLE);
    expect(res.body.configured).toBe(true);
  });

  it('库里是坏 JSON → 读回默认，但 configured 仍 true（键在就是配过，别把用户重新问一遍）', async () => {
    getDb()
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
      .run(SETTING_KEY_ANSWER_STYLE, '{"verbosity":');
    const res = await get().expect(200);
    expect(res.body.style).toEqual(DEFAULT_ANSWER_STYLE);
    expect(res.body.configured).toBe(true);
  });

  it('DELETE → 回到未配置态，下次出题会重新问一次', async () => {
    await put({ style: { verbosity: 'detailed' } }).expect(200);
    const res = await del().expect(200);
    expect(res.body.style).toEqual(DEFAULT_ANSWER_STYLE);
    expect(res.body.configured).toBe(false);
    expect(rawRow()).toBeUndefined();
  });

  it('写操作无 Origin → 403（与其余设置接口同一道闸门）', async () => {
    await request(app).put('/api/settings/answer-style').send({ style: {} }).expect(403);
    await request(app).delete('/api/settings/answer-style').expect(403);
  });
});
