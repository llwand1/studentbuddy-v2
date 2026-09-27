/**
 * tools/eval/lib/recorder — 出题请求的**录制转发代理**。
 *
 * ★ 为什么要有这一层，而不是直接拿 `generateQuiz` 的返回值算指标：
 *   返回值只有「抢救之后」的题组。模型原样写了什么——JSON 合不合法、svg 里有没有裸引号、
 *   画了几张图、输出撞没撞 token 上限——全在解析阶梯里被消化掉了。而「一次成型率」
 *   量的恰好是这一段：**没有原始文本就没有这个指标**。
 *   原始文本一旦落到盘上，还有第二个好处：整套指标可以**离线重算**，
 *   CI 的 quiz-smoke 门禁因此能回放录制（不必每次真调模型，也不占 250 次/5 小时的免费额度）。
 *
 * ★ 凭据纪律：`Authorization` 头**原样转发、绝不落盘、绝不打印**。写入记录前整段删掉请求头。
 *   key 本身也从不经过本进程变量之外的地方——它由产品的 `storage/crypto.ts` 在发请求时解密，
 *   代理只是收到什么就转什么（见 `env.mts` 里「抄密文、不抄明文」那条）。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export interface RecordedCall {
  /** 第几笔（从 1 起），运行侧用它核对「这一轮确实发过一次请求」 */
  seq: number;
  status: number;
  ms: number;
  /** 转发给上游的请求体（含完整提示词，无凭据） */
  requestBody: unknown;
  /** 上游响应体原文；非 200 时是错误正文 */
  responseBody: string;
  /** 代理自身没打到上游（连不上/超时）时写这里 */
  proxyError?: string;
}

export interface Recorder {
  /**
   * 给 providers 表用的 base_url。
   * ★ **刻意不带 `/v1`**：产品的 openai 适配器拼的是 `${base_url}/chat/completions`，而真实
   *   provider 行的 `base_url` 自己就带着 `/v1`（现查：`https://api.agnes-ai.cn/v1`）。
   *   这里再补一个 `/v1`，转出去就是 `/v1/v1/chat/completions` → 上游 404（第一版真撞上了）。
   *   代理只把「适配器请求的路径」原样接到上游 base_url 后面，所以自己这侧不加前缀。
   */
  baseUrl: string;
  port: number;
  rawDir: string;
  /** 已录到的笔数 */
  count(): number;
  /** 最近一笔；没有则 null */
  last(): RecordedCall | null;
  close(): Promise<void>;
}

const REDACT_NOTE = { redacted: 'Authorization 头刻意不入库（评测录制件会随报告提交）' };

/**
 * 起一个只监听 127.0.0.1 的转发代理。
 * @param upstreamBaseUrl 真实上游的 `/v1` 前缀（从真实库的 provider 行读来，不写死在代码里）
 */
export async function startRecorder(upstreamBaseUrl: string, rawDir: string): Promise<Recorder> {
  fs.mkdirSync(rawDir, { recursive: true });
  const records: RecordedCall[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const started = Date.now();
      const raw = Buffer.concat(chunks).toString('utf8');
      let requestBody: unknown = raw;
      try {
        requestBody = JSON.parse(raw);
      } catch {
        /* 非 JSON 的请求体原样留着，便于事后人看 */
      }
      const target = upstreamBaseUrl.replace(/\/$/, '') + (req.url ?? '');
      const auth = req.headers.authorization ?? '';
      void (async () => {
        let status = 502;
        let responseBody = '';
        let proxyError: string | undefined;
        try {
          const r = await fetch(target, {
            method: req.method ?? 'POST',
            headers: { 'content-type': 'application/json', authorization: auth },
            body: raw,
          });
          status = r.status;
          responseBody = await r.text();
        } catch (err) {
          proxyError = err instanceof Error ? err.message : String(err);
          responseBody = JSON.stringify({ error: 'proxy-upstream-failed', detail: proxyError });
        }
        const rec: RecordedCall = {
          seq: records.length + 1,
          status,
          ms: Date.now() - started,
          requestBody,
          responseBody,
          proxyError,
        };
        records.push(rec);
        const file = path.join(rawDir, `${String(rec.seq).padStart(4, '0')}.json`);
        // headers 字段刻意不存在：请求头里有真 key，写盘就等于把凭据塞进一个会被提交目录的树
        fs.writeFileSync(file, JSON.stringify({ ...rec, authHeader: REDACT_NOTE }, null, 2), 'utf8');
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(responseBody);
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    rawDir,
    count: () => records.length,
    last: () => records[records.length - 1] ?? null,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * 从录制里取出模型写的文本。
 * ★ 三种形状都得兜，兜不到就当空文本（评测口径里「拿不到原文」必须显式存在，不能悄悄给个 `{}`）：
 *   ① 非流式：`choices[0].message.content`，本仓 vision 那条链还可能是 part 数组（`chat/vision.ts`）；
 *   ② **流式 SSE**：`data: {...}\n\n` 一行一块，文本在 `choices[0].delta.content` 里逐块拼，
 *      末了是 `data: [DONE]`。★ 本仓的 openai 适配器**恒发 `stream: true`**
 *      （`stream_mode` 管的是前端一次显示还是逐字显示，不是线上协议），所以真实录制件就是这一种
 *      ——第一版没兜 SSE，`JSON.parse` 直接抛 ⇒ 原文恒为空 ⇒ 每组都被读成 `rescued`。
 *      这个假指标是跑出来的，不是推出来的（见 `runners/quiz.mts` 的 `empty-recording` 防呆）；
 *   ③ 解析不出上面任一种：返回空串，由运行侧判成传输失败，**不进一次成型的分母**。
 */
export function recordedText(rec: RecordedCall | null): string {
  if (!rec || rec.status !== 200) return '';
  let body: unknown;
  try {
    body = JSON.parse(rec.responseBody);
  } catch {
    return fromSse(rec.responseBody);
  }
  const choices = (body as { choices?: unknown }).choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const content = (first as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'object' && p && 'text' in p ? String((p as { text?: unknown }).text ?? '') : ''))
      .join('');
  }
  return '';
}

/** SSE 流式响应：逐块取 `delta.content` 拼回模型原文 */
function fromSse(body: string): string {
  let text = '';
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> };
      const c = chunk.choices?.[0]?.delta?.content;
      if (typeof c === 'string') text += c;
    } catch {
      // 心跳行/半截块：跳过即可，拼不出全文另有防呆兜着
    }
  }
  return text;
}
