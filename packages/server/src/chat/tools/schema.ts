/**
 * chat/tools/schema —— 工具参数预闸（契约 `docs/TOOL-ECOSYSTEM-SPEC.md` §4.2 纠错口径 / §4.5）。
 *
 * 为什么手写而不是引 ajv：本项目零运行时依赖原则（AGENTS.md），而现役 schema 只需要
 * JSON Schema 的一个小子集（type / enum / required / properties / items / minimum / maximum）。
 *
 * 定位（对齐 AI SDK 的 invalid_tool_error 模式）：校验失败**不执行工具**，
 * 回灌一条「怎么改对」的指示让模型自纠——小模型参数畸变（action 拼错、该给数组给了字符串）
 * 原先会渗进工具体内部被 String() 吞掉或跑出半途错，预闸把它拦在入口。
 *
 * 口径约束（回归锁钉死，勿改）：enum 违例的提示必须用 ` / ` 连接枚举值
 * （`tools/term-manage.test.ts` 断言 `toContain('add / update / delete')` 依赖这个形状）。
 */

type JsonSchema = Record<string, unknown>;

/** 顶层参数校验：通过返回 null；失败返回回灌给模型的完整纠错文案 */
export function validateToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  parameters: JsonSchema | undefined,
): string | null {
  if (!parameters || parameters.type !== 'object') return null;
  const err = checkValue(args, parameters, '');
  if (!err) return null;
  return `工具 ${toolName} 参数校验失败：${err}。请按参数定义修正后重新调用。`;
}

/** 校验单个值；返回 null=通过，字符串=错误描述（自带路径，如 options[0].label） */
function checkValue(value: unknown, schema: JsonSchema, path: string): string | null {
  const label = path ? `参数 ${path}` : '参数';
  const type = schema.type;
  if (typeof type === 'string' && !matchesType(value, type)) {
    const got = typeOf(value);
    // NaN/Infinity 与 integer 收到小数：类型名相同，报值才有信息量（「应为数字（实际是数字）」是废话）
    const shown = got === type ? (JSON.stringify(value) ?? String(value)) : typeLabel(got);
    return `${label} 应为${typeLabel(type)}（实际是${shown}）`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    return `${label} 只能是 ${schema.enum.join(' / ')} 之一`;
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) {
      if (obj[key] === undefined || obj[key] === null) {
        return `参数 ${path ? `${path}.${key}` : key} 缺失（必填）`;
      }
    }
    for (const [key, child] of Object.entries(obj)) {
      const sub = props[key];
      // 未知字段放行（JSON Schema 默认 additionalProperties:true；`ask_choice` 的 multi 就靠这条）
      if (!sub) continue;
      const err = checkValue(child, sub, path ? `${path}.${key}` : key);
      if (err) return err;
    }
  }
  if (Array.isArray(value) && typeof schema.items === 'object' && schema.items !== null) {
    const items = schema.items as JsonSchema;
    for (let i = 0; i < value.length; i++) {
      const err = checkValue(value[i], items, `${path ?? '参数'}[${i}]`);
      if (err) return err;
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return `${label} 不得小于 ${schema.minimum}`;
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return `${label} 不得大于 ${schema.maximum}`;
    }
  }
  return null;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return typeOf(v) === 'object';
    default:
      return true; // 不认识的 type（如 'any'）放行，不拦
  }
}

const TYPE_LABEL: Record<string, string> = {
  string: '字符串',
  number: '数字',
  integer: '整数',
  boolean: '真/假值',
  array: '数组',
  object: '对象',
  null: '空值',
  undefined: '缺失',
};

function typeLabel(t: string): string {
  return TYPE_LABEL[t] ?? t;
}
