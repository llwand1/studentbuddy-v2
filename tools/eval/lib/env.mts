/**
 * tools/eval/lib/env — 评测台的产品环境：临时库 + 录制代理 + 从真实库**抄来的**那条 provider 行。
 *
 * ★ 抄的是密文，不是明文：真实库里 `providers.api_key` 是 `enc:v1:` 开头的密文（主密钥在真实数据目录的
 *   `.mk`，本机 DPAPI 包裹）。本文件把那一整串**原样 INSERT 进临时库**，解密发生在产品自己的
 *   `storage/crypto.ts` 里（同一台机器、同一个 `.mk`）⇒ 评测代码从头到尾没看过明文 key，
 *   也没有任何一处把它打印或写盘。
 * ★ 真实库以 `readonly: true` 打开，评测台对它**零写入**（它装着用户数据）。
 * ★ 临时库走独立目录（不用 `SB_DATA_DIR`——那个变量会改变 `.mk` 的查找位置，改了就读不到 key 了），
 *   退出时整目录删除。产品测试的同类做法见 `tools/test-tmp.mjs`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR, closeDb, openIsolated } from '../../../packages/server/src/storage/db.js';
import { startRecorder, type Recorder } from './recorder.mts';

export interface BorrowedProvider {
  /** 真实上游 `/v1` 前缀，交给录制代理当转发目标 */
  upstreamBaseUrl: string;
  /** `enc:v1:` 密文，原样抄进临时库 */
  encryptedKey: string;
  type: string;
  streamMode: string | null;
  /** 真实库里该角色绑的模型名——评测必须钉住同名，否则「换了个模型」也会读成「质量变了」 */
  model: string;
}

/** 从真实库读 quiz-generator 角色实际会用的那条 provider（只读，取第一个 enabled 的平台行） */
export function borrowProvider(): BorrowedProvider {
  const dbPath = path.join(DATA_DIR, 'studentbuddy.db');
  if (!fs.existsSync(dbPath)) throw new Error(`找不到真实库：${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT p.base_url AS base_url, p.api_key AS api_key, p.type AS type, p.stream_mode AS stream_mode
           FROM role_bindings b JOIN providers p ON p.id = b.provider_id
          WHERE b.role = 'quiz-generator' AND b.owner_id IS NULL AND p.enabled = 1
          LIMIT 1`,
      )
      .get() as
      | { base_url: string; api_key: string; type: string; stream_mode: string | null }
      | undefined;
    if (!row) throw new Error('真实库里没有启用的「出题」角色绑定，评测无从发起真调');
    const model = (
      db.prepare("SELECT model FROM role_bindings WHERE role = 'quiz-generator' AND owner_id IS NULL").get() as
        | { model: string }
        | undefined
    )?.model;
    if (!model) throw new Error('「出题」角色绑定里没有模型名');
    return {
      upstreamBaseUrl: row.base_url,
      encryptedKey: row.api_key,
      type: row.type,
      streamMode: row.stream_mode,
      model,
    };
  } finally {
    db.close();
  }
}

export interface EvalEnv {
  dataDir: string;
  recorder: Recorder;
  model: string;
  close(): Promise<void>;
}

/**
 * 起环境：临时库（跑全套迁移）→ 录制代理 → 把抄来的 provider 与角色绑定写进临时库。
 * 之后 `routeRole('quiz-generator', undefined, null)` 在产品自己的代码里读到的就是这一行，
 * 于是**产品的调用链一行没改**，只是地址换成了本地代理。
 */
export async function bootEvalEnv(opts: { rawDir: string; role?: 'quiz-generator' }): Promise<EvalEnv> {
  const borrowed = borrowProvider();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-eval-'));
  openIsolated(dataDir);
  const recorder = await startRecorder(borrowed.upstreamBaseUrl, opts.rawDir);

  const { getDb } = await import('../../../packages/server/src/storage/db.js');
  const db = getDb();
  db.prepare(
    `INSERT INTO providers (id, name, base_url, api_key, type, enabled, stream_mode, owner_id)
     VALUES ('sb-eval-proxy', 'sb-eval-proxy', ?, ?, ?, 1, ?, NULL)`,
  ).run(recorder.baseUrl, borrowed.encryptedKey, borrowed.type, borrowed.streamMode);
  db.prepare('INSERT OR REPLACE INTO role_bindings (role, provider_id, model, owner_id) VALUES (?, ?, ?, NULL)').run(
    opts.role ?? 'quiz-generator',
    'sb-eval-proxy',
    borrowed.model,
  );

  return {
    dataDir,
    recorder,
    model: borrowed.model,
    close: async () => {
      await recorder.close();
      closeDb();
      // 临时库连同 WAL sidecar 整目录删掉；删不掉要吼一声，不能静默留一地 sb-eval-*
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`⚠️ 临时库目录没删干净：${dataDir}（${String(err)}）`);
      }
    },
  };
}
