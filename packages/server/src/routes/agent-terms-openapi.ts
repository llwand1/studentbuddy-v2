/** 供 coding agent 获取的机器契约；只登记这个权限受限的接口。 */
const response = { description: 'JSON 回执或明确错误' };
import { seedPaths, seedSchemas } from './question-seeds-openapi.js';
const operation = (summary: string) => ({ summary, security: [{ AgentKey: [] }], responses: { '200': response, '400': response, '401': response, '429': response } });
export const agentTermsOpenApi = {
  openapi: '3.0.3', info: { title: 'StudentBuddy 外部学习补给接口', version: '1.1.0', description: '专用密钥读取本人词库、追加新词；显式勾选出题预产物后可读写考点蓝图与参数空间。旧密钥不扩权。不访问聊天或设置。密钥在设置页生成。' },
  servers: [{ url: '/api/open/v1' }],
  paths: {
    ...seedPaths,
    '/context': { get: operation('当前应试范围与领域，先读此处再检索') },
    '/terms': { get: { ...operation('全部本人词条，包含当前应试范围外的词用于排重'), parameters: [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
      { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 } },
    ] } },
    '/terms/import': { post: { ...operation('一次追加 1–100 条；同 batchId 重试幂等，同 ID 不同内容 409'),
      description: '请求最多512KiB，整批校验失败零写入。回执含added/skipped及逐条id、status、visibleInCurrentScope、warnings。来源只代表导入者提供，不冒充服务端已抓取证据。无网页来源或白名单外词仍保存，当前应试视图可能不显示。source_host只作注记。',
      responses: { ...operation('').responses, '409': response, '413': response },
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['batchId', 'terms'], properties: {
        batchId: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' },
        review: { type: 'boolean', default: true, description: '新词加入复习；false继承领域开关，不改已有词' },
        terms: { type: 'array', minItems: 1, maxItems: 100, items: { $ref: '#/components/schemas/Term' } },
      } } } } },
    } },
  },
  components: { securitySchemes: { AgentKey: { type: 'http', scheme: 'bearer', bearerFormat: 'sb_terms_...' } }, schemas: {
    ...seedSchemas,
    Term: { type: 'object', additionalProperties: false, required: ['term', 'definition'], properties: {
      term: { type: 'string', minLength: 1, maxLength: 100 }, definition: { type: 'string', minLength: 1, maxLength: 4000 },
      domain: { type: 'string', minLength: 1, maxLength: 30, default: 'general' }, importance: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
      aliases: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 100 } },
      sourceUrls: { type: 'array', maxItems: 3, items: { type: 'string', format: 'uri', maxLength: 2000 } },
      sourceNote: { type: 'string', maxLength: 300 }, source_host: { type: 'string', maxLength: 300 }, freq: { type: 'number', minimum: 0 },
    } },
  } },
};
