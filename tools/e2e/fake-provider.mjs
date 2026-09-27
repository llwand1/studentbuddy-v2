/**
 * tools/e2e/fake-provider.mjs — 确定性假 LLM 上游（OpenAI 兼容），`npm run demo:e2e` 专用。
 *
 * 设计：按请求体里的 `model` 字段分派响应（E2E 把 explain 角色绑 fake-chat、
 * quiz-generator 绑 fake-quiz），因此**同一份 fake 能同时喂对话链路与出题链路**，
 * 全程零真实网络、零 API key。未知 model 回一句无害文本——正好演练本仓的降级面：
 * 解析不出协议的杂文本不会打断主轮（post-turn 抽词等旁路调用走的就是这条路）。
 *
 * 与 _probe/fake-provider.mjs 的分工：那份按 gitignore 存世、专用于并发故障复现
 * （带延迟与 in-flight 日志）；这份随仓分发、面向面试官一条命令，输出恒定。
 */
import http from 'node:http';

const QUIZ_JSON = JSON.stringify({
  title: 'E2E 演示题组 · 牛顿运动定律',
  questions: [
    {
      type: 'single',
      question: '（演示 1）物体的加速度方向一定与下列哪个方向相同？',
      options: ['速度方向', '合外力方向', '位移方向', '运动轨迹切线方向'],
      answer: [1],
      explanation: '牛顿第二定律：加速度方向与合外力方向相同。',
      svg: '',
      refs: [],
    },
    {
      type: 'single',
      question: '（演示 2）质量 2 kg 的物体受 6 N 合力，加速度为多少 m/s²？',
      options: ['1', '2', '3', '6'],
      answer: [2],
      explanation: 'a = F/m = 6/2 = 3 m/s²。',
      svg: '',
      refs: [],
    },
    {
      type: 'multiple',
      question: '（演示 3）下列哪些属于牛顿运动定律的直接推论？（多选）',
      options: ['力是维持运动的原因', '作用力与反作用力等大反向', '惯性只与质量有关', '加速度与合力成正比'],
      answer: [1, 2, 3],
      explanation: '牛顿第一/第二/第三定律。',
      svg: '',
      refs: [],
    },
    {
      type: 'fill',
      question: '（演示 4）牛顿第二定律的公式：F = ____（填表达式）。',
      answer: ['ma'],
      explanation: 'F = ma。',
      svg: '',
      refs: [],
    },
  ],
});

/** 按 model 名分派最终文本；返回 undefined 表示走杂文本降级。 */
function contentFor(model) {
  if (model === 'fake-quiz') return `[QUIZ]${QUIZ_JSON}[/QUIZ]`;
  if (model === 'fake-chat') {
    return '牛顿第二定律：物体的加速度与所受合外力成正比、与质量成反比，方向与合外力方向相同，公式 F = ma。这是「学 → 练 → 析 → 忆 → 反馈」闭环里「学」环节的一条真实回复路径。';
  }
  return '（fake-provider 通用回复：本模型未登记专用响应，返回一段不含任何协议的文本。）';
}

function openAiJson(model, content, id) {
  return {
    id: `cmpl-fake-${id}`,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 42, completion_tokens: 21, total_tokens: 63 },
  };
}

function openAiStreamFrames(content) {
  // 切成固定小片：证明 SSE 真的按帧流式上屏，而不是整块塞回
  const pieces = content.match(/.{1,12}/gs) ?? [content];
  return pieces.map((p, i) => ({
    choices: [{ index: 0, delta: { content: p }, finish_reason: null }].concat(i === pieces.length - 1 ? [] : []),
  }));
}

/**
 * @param {number} [port] 传 0 由系统分配；返回 { server, port(), calls }
 */
export function startFakeProvider(port = 0) {
  const calls = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* 非 JSON 请求：按未知 model 处理 */
      }
      const id = ++n;
      const model = String(parsed.model ?? '');
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      calls.push({ id, model, stream: parsed.stream === true, messageCount: messages.length });
      const content = contentFor(model);
      if (parsed.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        for (const f of openAiStreamFrames(content)) res.write(`data: ${JSON.stringify(f)}\n\n`);
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 21 } })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(openAiJson(model, content, id)));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        server,
        port: () => actual,
        baseUrl: () => `http://127.0.0.1:${actual}/v1`,
        calls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// 允许独立起进程调试：node tools/e2e/fake-provider.mjs
if (process.argv[1] && process.argv[1].endsWith('fake-provider.mjs')) {
  const p = Number(process.env.FAKE_PORT ?? 18800);
  startFakeProvider(p).then((f) => console.log(`[fake-provider] listening http://127.0.0.1:${f.port()}/v1`));
}
