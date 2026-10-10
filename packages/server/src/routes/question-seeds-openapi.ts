/** 独立机器契约：字段不是成品题，也不是可执行代码。 */
const string = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const texts = (minItems: number, maxItems: number, chars: number) => ({ type: 'array', minItems, maxItems, items: string(chars) });
const integers = (minimum: number, maximum: number) => ({ type: 'array', minItems: 2, maxItems: 10, uniqueItems: true, items: { type: 'integer', minimum, maximum } });
const security = [{ AgentKey: [] }];
const responses = Object.fromEntries([200, 400, 401, 403, 404, 409, 413, 429, 500].map(n => [String(n), { description: 'JSON 回执或明确错误' }]));
export const seedPaths = {
  '/question-seeds': { get: { summary: '分页读取本人预产物、范围可用性与剩余参数组合', security, responses, parameters: [
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
    { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 } },
  ] } },
  '/question-seeds/import': { post: { summary: '原子追加 1–50 个考点蓝图/参数空间，同 batchId 重试幂等', security, responses,
    description: '须在设置页创建密钥时勾选出题预产物（questionSeeds:true）；旧词条密钥返回403。scopeSignature从context.exam.signature原样复制，validUntil用未来一年内UTC ISO时间。不接受question/options/answer，不直接出题、不写聊天；来源仅表示导入者提供。过期/范围外不参与出题。',
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['batchId', 'seeds'], properties: {
      batchId: { ...string(100), pattern: '^[A-Za-z0-9._:-]+$' }, seeds: { type: 'array', minItems: 1, maxItems: 50, items: { $ref: '#/components/schemas/QuestionSeed' } },
    } }, example: { batchId: 'math-prep-1', seeds: [{ externalId: 'linear-1', topic: '一元一次方程', domain: 'math', tags: ['数学', '一元一次方程'], objective: '运用等式性质求解并代入检验', facts: ['等式两边加减同一个数仍相等；除以相同非零数仍相等'], misconceptions: ['移项时忘记改变符号'], rubric: ['两边做同样运算', '代入验证等式'], variations: ['更换非零系数、常数和整数解'], types: ['single', 'judge', 'fill', 'essay'], sourceUrls: [], scopeSignature: 'all', validUntil: new Date(Date.now() + 30 * 86400000).toISOString(), recipe: { kind: 'linear-equation', coefficients: [-3, -2, 2, 3], constants: [-4, -1, 1, 4], solutions: [-3, -1, 1, 3] } }] } } } },
  } },
  '/question-seeds/{id}': { delete: { summary: '撤下本账号预产物；不删除词条或聊天', security, responses, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
};
export const seedSchemas = { QuestionSeed: { type: 'object', additionalProperties: false,
  required: ['externalId', 'topic', 'tags', 'objective', 'facts', 'rubric', 'variations', 'types', 'validUntil'], properties: {
    externalId: { ...string(100), pattern: '^[A-Za-z0-9._:-]+$' }, topic: string(100), domain: { ...string(30), default: 'general' },
    tags: texts(1, 12, 80), objective: string(300), facts: texts(1, 12, 1000), misconceptions: texts(0, 8, 300), rubric: texts(1, 8, 300), variations: texts(1, 8, 300),
    types: { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: { type: 'string', enum: ['single', 'multiple', 'judge', 'fill', 'essay'] } },
    sourceUrls: { type: 'array', maxItems: 3, items: { type: 'string', format: 'uri', maxLength: 2000 } },
    scopeSignature: { ...string(1000), default: 'all' }, validUntil: { type: 'string', format: 'date-time', description: '未来一年内 UTC 时间；时效资料请设置短期限' },
    recipe: { type: 'object', additionalProperties: false, required: ['kind', 'coefficients', 'constants', 'solutions'], description: '仅 domain=math、topic=一元一次方程可用；coefficients不可有0，types不可有multiple', properties: {
      kind: { type: 'string', enum: ['linear-equation'] }, coefficients: integers(-9, 9), constants: integers(-20, 20), solutions: integers(-20, 20),
    } },
  },
} };
