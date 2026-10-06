/** AI 只修改当前账号的应试来源配置；确认与原子保存复用现有写门面。 */
import { EXAM_PACKS, MAX_EXAM_CUSTOM_HOSTS, normalizeExamHost, type ExamScopeSetting } from '@sb/shared';
import { loadExamMode, loadExamScope, readExamModeView, saveExamMode, saveExamScope } from '../../learning/exam-mode.js';
import { getDb } from '../../storage/db.js';
import { registerTool, zeroWritePlan } from './registry.js';

const packMap = new Map(EXAM_PACKS.map(p => [p.id, p.label]));
const fingerprint = (on: boolean, scope: ExamScopeSetting) => JSON.stringify([on, [...scope.packs].sort(), [...scope.custom].sort()]);
const strings = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

registerTool('read_exam_scope', {
  kind: 'read',
  definition: { type: 'function', function: { name: 'read_exam_scope',
    description: '查看学习者当前应试模式开关、来源白名单和可选考试/求职类目编号。修改前先读取，不猜类目编号或现有范围。',
    parameters: { type: 'object', properties: {} } } },
  async run(_args, ctx) {
    return { content: JSON.stringify({ ...readExamModeView(ctx.ownerId), availablePacks: EXAM_PACKS.map(p => ({ id: p.id, label: p.label })) }) };
  },
});

registerTool('update_exam_scope', {
  kind: 'write', needsConfirm: true,
  definition: { type: 'function', function: { name: 'update_exam_scope',
    description: '按用户要求修改应试来源白名单和开关，显示差异并等待确认后保存。只改当前账号；未提供的集合保持原值，不能改系统安全白名单。先用 read_exam_scope 读取；仅用户明确要求整体替换时用 setPacks/setHosts。',
    parameters: { type: 'object', properties: {
      on: { type: 'boolean', description: '可选：开启或关闭应试模式；不提供则保持原值' },
      addPacks: strings('新增类目编号'), removePacks: strings('移除类目编号'), setPacks: strings('整体替换类目编号集合；空数组表示清空'),
      addHosts: strings('新增自填站点域名'), removeHosts: strings('移除自填站点域名'), setHosts: strings('整体替换自填域名集合；空数组表示清空'),
    } } } },
  async planWrite(args, ctx) {
    const before = readExamModeView(ctx.ownerId);
    const list = (key: string, domain: boolean): string[] => {
      const raw = args[key];
      if (raw === undefined) return [];
      if (!Array.isArray(raw) || raw.length > (domain ? MAX_EXAM_CUSTOM_HOSTS : EXAM_PACKS.length)) throw new Error(`${key} 的数量不合法`);
      const values = raw.map(v => domain ? normalizeExamHost(v) : typeof v === 'string' && packMap.has(v) ? v : null);
      if (values.some(v => !v)) throw new Error(`${key} 包含${domain ? '非法域名' : '未知类目编号，请先读取可选类目'}`);
      return [...new Set(values as string[])];
    };
    let next: ExamScopeSetting;
    try {
      const edit = (current: string[], set: string, add: string, remove: string, domain: boolean): string[] => {
        const additions = list(add, domain), removals = list(remove, domain), replacement = list(set, domain);
        if (additions.some(v => removals.includes(v))) throw new Error('不能同时新增和移除同一项');
        const edited = [...new Set([...current.filter(v => !removals.includes(v)), ...additions])];
        if (args[set] !== undefined && (args[add] !== undefined || args[remove] !== undefined)
          && JSON.stringify([...edited].sort()) !== JSON.stringify([...replacement].sort())) throw new Error(`${set} 与 ${add}/${remove} 的结果冲突；只选一种方式`);
        return args[set] !== undefined ? replacement : edited;
      };
      next = { packs: edit(before.scope.packs, 'setPacks', 'addPacks', 'removePacks', false), custom: edit(before.scope.custom, 'setHosts', 'addHosts', 'removeHosts', true) };
      if (next.custom.length > MAX_EXAM_CUSTOM_HOSTS) throw new Error(`自填域名最多 ${MAX_EXAM_CUSTOM_HOSTS} 个`);
    } catch (e) { return zeroWritePlan(`白名单未修改：${e instanceof Error ? e.message : String(e)}。请修正参数后重新调用。`); }
    const on = typeof args.on === 'boolean' ? args.on : before.on;
    const items: string[] = [];
    const changes = (old: string[], updated: string[], label: (v: string) => string) => {
      for (const v of updated) if (!old.includes(v)) items.push(`新增：${label(v)}`);
      for (const v of old) if (!updated.includes(v)) items.push(`移除：${label(v)}`);
    };
    changes(before.scope.packs, next.packs, id => packMap.get(id) ?? id);
    changes(before.scope.custom, next.custom, host => host);
    if (on !== before.on) items.push(on ? '开启应试模式' : '关闭应试模式');
    if (!items.length) return zeroWritePlan('白名单和应试开关与现状一致，无需修改。');
    const snapshot = fingerprint(before.on, before.scope);
    return { affected: items.length, actionSummary: '调整应试来源白名单与学习范围', items,
      apply: async () => {
        if (ctx.signal?.aborted) return { content: '本次修改已取消，白名单未写入。', meta: { affected: 0 } };
        const saved = getDb().transaction(() => {
          if (fingerprint(loadExamMode(ctx.ownerId), loadExamScope(ctx.ownerId)) !== snapshot) return false;
          saveExamScope(next, ctx.ownerId);
          saveExamMode(on, ctx.ownerId);
          return true;
        })();
        if (!saved) return { content: '确认期间应试设置已经发生变化，本次整批中止，未覆盖新值。请先重新读取范围。', meta: { affected: 0 } };
        const actual = readExamModeView(ctx.ownerId);
        ctx.onStep('update_exam_scope', 'done', '应试来源白名单已保存');
        return { content: `已保存本次确认的修改：${items.join('；')}。实际配置：${JSON.stringify(actual)}。请简短告知用户实际生效范围；模式关闭时说明配置已保存但未启用，不要声称检索已经受限。`, meta: { affected: items.length } };
      } };
  },
});
