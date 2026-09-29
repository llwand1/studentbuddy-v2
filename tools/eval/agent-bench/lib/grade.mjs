/**
 * agent-bench/lib/grade —— 轨迹判分器（纯函数，零 IO，selftest 直接打它）。
 *
 * 判的对象是一条**轨迹**（trajectory）：
 *   { calls: [{ name, args, rawArgs, step }], final: string, steps: number, loopCapped: boolean }
 *
 * 检查分两层（口径对齐主流做法）：
 *  ── 全局硬检查（每条轨迹都跑，BFCL 的 AST 检查同型）──
 *   schema      每次调用的 rawArgs 必须是合法 JSON，且过镜像 schema 的子集校验
 *               （type / enum / required / items / minimum / maximum —— 与生产 `chat/tools/schema.ts` 同一子集）
 *   no-dup      同名同参的调用不许出现两次（生产注册表按「同参幂等重试」设计，模型侧重复＝空转）
 *   loop-cap    没在步数上限内收尾 ⇒ 直接不及格
 *  ── 用例声明式检查（expect 字段，τ-bench 的目标态检查同型）──
 *   tools       期望调用序列（默认有序子序列匹配；unordered: true 时不计顺序），逐参数断言
 *   noTools     一次工具都不许调（BFCL 的 relevance detection）
 *   forbid      禁调清单；forbidUnlessAfter: { 工具: 前置工具 } 表达「没先查不许删」这类政策
 *   calls       某工具的调用次数上下界（如「终点信号不许重试」⇒ 恰好 1 次）
 *   final       对最终回答的 includesAny / includesAll / excludes
 */
import { toolByName } from './tools-mirror.mjs';

// ── schema 子集校验（与生产 chat/tools/schema.ts 同一子集；这里只回布尔+原因，不做纠错回灌）──
function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
function matchesType(v, type) {
  const got = typeOf(v);
  if (type === 'number') return got === 'number' || got === 'integer';
  if (type === 'integer') return got === 'integer';
  return got === type;
}
function checkValue(value, schema, path) {
  const label = path || '(root)';
  if (typeof schema.type === 'string' && !matchesType(value, schema.type)) {
    return `${label} 应为 ${schema.type}，实际 ${typeOf(value)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${label} 不在枚举内`;
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${label} < minimum`;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${label} > maximum`;
  }
  if (schema.type === 'array' && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const err = checkValue(value[i], schema.items, `${label}[${i}]`);
      if (err) return err;
    }
  }
  if (schema.type === 'object' && schema.properties) {
    for (const k of schema.required ?? []) {
      if (value[k] === undefined || value[k] === null || value[k] === '') return `${label}.${k} 必填缺失`;
    }
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties[k]) {
        const err = checkValue(v, schema.properties[k], path ? `${label}.${k}` : k);
        if (err) return err;
      }
    }
  }
  return null;
}

/** 校验一次调用：工具存在 + JSON 合法 + schema 通过。返回 null=过，字符串=败因。 */
export function validateCall(call) {
  const tool = toolByName(call.name);
  if (!tool) return `未知工具 ${call.name}`;
  if (call.args === null) return `参数不是合法 JSON：${String(call.rawArgs).slice(0, 80)}`;
  return checkValue(call.args, tool.function.parameters, '');
}

// ── 参数断言 ──
function argValue(args, key) {
  return args?.[key];
}
function checkArg(args, key, rule, fails) {
  const v = argValue(args, key);
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (rule.equals !== undefined && v !== rule.equals) fails.push(`${key} 应=${JSON.stringify(rule.equals)}，实际 ${s}`);
  if (rule.includesAny && !rule.includesAny.some((n) => s?.includes(n))) fails.push(`${key} 未含 ${rule.includesAny.join('/')} 任一`);
  if (rule.containsAll && !rule.containsAll.every((n) => s?.includes(n))) fails.push(`${key} 未全含 ${rule.containsAll.join('+')}`);
  if (rule.nonEmpty && !(typeof v === 'string' ? v.trim() : v !== undefined && v !== null)) fails.push(`${key} 为空`);
  if (rule.isArray && !Array.isArray(v)) fails.push(`${key} 应为数组`);
}
function callMatches(call, spec) {
  if (call.name !== spec.name) return false;
  const fails = [];
  for (const [k, rule] of Object.entries(spec.args ?? {})) checkArg(call.args ?? {}, k, rule, fails);
  return fails.length === 0;
}

/** 判一条轨迹。返回 { pass, fails: string[] }。 */
export function gradeTrajectory(traj, expect) {
  const fails = [];
  // 全局硬检查
  for (const c of traj.calls) {
    const err = validateCall(c);
    if (err) fails.push(`[schema] ${c.name}: ${err}`);
  }
  const seen = new Set();
  for (const c of traj.calls) {
    const key = `${c.name}|${JSON.stringify(c.args)}`;
    if (seen.has(key)) fails.push(`[no-dup] ${c.name} 同参重复调用`);
    seen.add(key);
  }
  if (traj.loopCapped) fails.push('[loop-cap] 到步数上限仍未收尾');
  // 声明式检查
  if (expect.noTools && traj.calls.length > 0) {
    fails.push(`[relevance] 应零调用，实际调了 ${traj.calls.map((c) => c.name).join(',')}`);
  }
  if (expect.maxCalls !== undefined && traj.calls.length > expect.maxCalls) {
    fails.push(`[budget] 调用 ${traj.calls.length} 次 > 上限 ${expect.maxCalls}`);
  }
  for (const name of expect.forbid ?? []) {
    if (traj.calls.some((c) => c.name === name)) fails.push(`[forbid] 调了禁调工具 ${name}`);
  }
  for (const [name, mustAfter] of Object.entries(expect.forbidUnlessAfter ?? {})) {
    const idx = traj.calls.findIndex((c) => c.name === name);
    if (idx >= 0 && !traj.calls.slice(0, idx).some((c) => c.name === mustAfter)) {
      fails.push(`[policy] ${name} 出现在 ${mustAfter} 之前（没先查不许动手）`);
    }
  }
  for (const [name, bounds] of Object.entries(expect.calls ?? {})) {
    const n = traj.calls.filter((c) => c.name === name).length;
    if (bounds.exactly !== undefined && n !== bounds.exactly) fails.push(`[count] ${name} 应恰 ${bounds.exactly} 次，实际 ${n}`);
    if (bounds.atLeast !== undefined && n < bounds.atLeast) fails.push(`[count] ${name} 应≥${bounds.atLeast} 次，实际 ${n}`);
  }
  if (expect.tools) {
    if (expect.unordered) {
      const used = new Set();
      for (const spec of expect.tools) {
        const i = traj.calls.findIndex((c, k) => !used.has(k) && callMatches(c, spec));
        if (i < 0) fails.push(`[traj] 缺少符合断言的调用 ${spec.name}`);
        else used.add(i);
      }
    } else {
      let cursor = 0;
      for (const spec of expect.tools) {
        let hit = -1;
        for (let i = cursor; i < traj.calls.length; i++) {
          if (callMatches(traj.calls[i], spec)) {
            hit = i;
            break;
          }
        }
        if (hit < 0) {
          const near = traj.calls.find((c) => c.name === spec.name);
          fails.push(near ? `[traj] ${spec.name} 已调用但参数不合断言` : `[traj] 期望序列缺 ${spec.name}`);
        } else cursor = hit + 1;
      }
    }
  }
  const fin = expect.final ?? {};
  const text = traj.final ?? '';
  if (fin.includesAny && !fin.includesAny.some((n) => text.includes(n))) fails.push(`[final] 未含 ${fin.includesAny.join('/')} 任一`);
  if (fin.includesAll && !fin.includesAll.every((n) => text.includes(n))) fails.push(`[final] 未全含 ${fin.includesAll.join('+')}`);
  if (fin.excludes && fin.excludes.some((n) => text.includes(n))) fails.push('[final] 含禁词');
  return { pass: fails.length === 0, fails };
}

// ── 判分器自检：合法/违规轨迹各若干，「该抓的抓到、该放的放行」 ──
export function selftestGrader() {
  const mk = (calls, final, extra = {}) => ({
    calls: calls.map((c, i) => ({ name: c[0], args: c[1], rawArgs: JSON.stringify(c[1]), step: i })),
    final,
    steps: calls.length + 1,
    loopCapped: false,
    ...extra,
  });
  const cases = [
    // 该放行的
    [mk([['search_web', { query: '诺贝尔物理学奖 2024' }]], '得主是 Hopfield 与 Hinton。'), { tools: [{ name: 'search_web', args: { query: { includesAny: ['诺贝尔'] } } }], final: { includesAny: ['Hinton', 'Hopfield'] } }, true],
    [mk([], '答案是 1591。'), { noTools: true, final: { includesAll: ['1591'] } }, true],
    [mk([['lookup_terms', {}], ['delete_terms', { terms: ['废词'] }]], '已提交删除。'), { forbidUnlessAfter: { delete_terms: 'lookup_terms' } }, true],
    // 该抓的
    [mk([['search_web', { query: 'x' }], ['search_web', { query: 'x' }]], '……'), {}, false], // no-dup
    [mk([['generate_quiz', { topic: '牛顿', count: '3' }]], '出好了'), {}, false], // schema: count 应为 integer
    [mk([['generate_quiz', { count: 3 }]], '出好了'), {}, false], // schema: topic 必填缺失
    [mk([['delete_terms', { terms: ['a'] }]], '删了'), { forbidUnlessAfter: { delete_terms: 'lookup_terms' } }, false],
    [mk([['tidy_terms', { action: 'rename' }]], '好'), {}, false], // enum 违例
    [mk([], '我不知道'), { tools: [{ name: 'search_web' }] }, false], // 缺期望调用
    [mk([['search_web', { query: 'x' }]], '8848 米'), { noTools: true }, false], // relevance
    [mk([['offer_pk_battle', { topic: '电磁感应', reason: '刚讲完' }], ['offer_pk_battle', { topic: '电磁感应', reason: '再试一次' }]], '发出了'), { calls: { offer_pk_battle: { exactly: 1 } } }, false],
    [mk([['search_web', { query: 'x' }]], '', { loopCapped: true }), {}, false],
  ];
  let n = 0;
  for (const [traj, expect, want] of cases) {
    const got = gradeTrajectory(traj, expect).pass;
    if (got !== want) throw new Error(`selftest #${n} 期望 ${want ? 'pass' : 'fail'} 实际相反：${JSON.stringify(gradeTrajectory(traj, expect).fails)}`);
    n++;
  }
  return { asserts: n };
}
