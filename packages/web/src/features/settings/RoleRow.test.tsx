// @vitest-environment jsdom
/**
 * RoleRow.test — 角色绑定行的**模型下拉**渲染层锁（2026-09-21，老板要「直接用选项选」）。
 *
 * 钉六件事（每一条都对应一个真会伤到用户的失败模式）：
 *   ① 有候选列表时渲染成 `<select>`，候选就是**服务商真实返回的模型**（不是手填输入框）；
 *   ② ★ **当前值不在候选列表里时，必须按「自定义」渲染** —— 这是本批最容易踩的显示层坑：
 *       `<select value="库里的名字">` 匹配不到任何 option 时，浏览器**静默显示第一项**，
 *      用户看到的是"绑的是 A"，实际存的是 B。不锁这条，改完看起来是好的、其实在说谎。
 *   ③ ★ **空模型 = 「用默认模型」，不算自定义** —— 首轮实测逮到的真 bug：
 *      `!models.includes('')` 恒为 true，于是每个**留空**的角色都被判成"自定义"，
 *      下拉显示成「自定义…」并凭空多出一个空输入框。空串是个**有明确选项**的合法状态，
 *      不是"没在候选里"。
 *   ④ 选「自定义…」才出现手填框（保留"中转站不实现 /models"时的出路）；
 *   ⑤ 选「（用默认模型）」保存的是**空串** —— 与「一键默认设置」写的是同一个值，
 *      两处口径必须一致（服务端已放行空模型）；
 *   ⑥ 候选为空时退化成纯输入框，**不把用户锁死**（一个可选项都没有的下拉是死路）。
 *   ⑦ ★★ **服务端值变了要跟着走** —— 真机探针逮到的真 bug，见文件末尾那个 describe。
 *      这是本批唯一一个"单测全绿但真机上用户点了没反应"的缺陷，锁它比锁前面六条都重要。
 *   ⑧ 服务端说"这个角色还没绑服务商"（空串）时，**不把用户正在选的服务商顶回第一个**
 *      ——"没绑"和"换了"是两回事，混为一谈会让用户觉得"选了没用"。
 *
 * ★ 本文件只测 `RoleRow` 自身的渲染与回调，**不替身任何模块**——它是纯展示组件，
 *   数据全从 props 来。父组件的编排（预拉模型、落库）由 `SettingsView` 的路径覆盖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RoleRow } from './RoleRow';
import type { ProviderRow } from './RoleRow';

const PROVIDERS: ProviderRow[] = [
  { id: 'openai-default', name: '默认服务商', baseUrl: 'https://x/v1', enabled: true, ownerId: null },
  { id: 'p-mine', name: '我的中转', baseUrl: 'https://y/v1', enabled: true, ownerId: 'uA' },
];

type RowProps = {
  modelsMap?: Record<string, string[]>;
  initialProvider?: string;
  initialModel?: string;
};

/** 一行的 JSX。抽出来是为了让 `rerender` 能用**同一组 spy**换 props 重渲染。 */
function rowEl(p: RowProps, onBind: (a: string, b: string) => void, onNeedModels: (a: string) => void) {
  return (
    <table>
      <tbody>
        <RoleRow
          label="讲解（日常对话）"
          providers={PROVIDERS}
          modelsMap={p.modelsMap ?? {}}
          initialProvider={p.initialProvider ?? 'openai-default'}
          initialModel={p.initialModel ?? ''}
          onBind={onBind}
          onNeedModels={onNeedModels}
        />
      </tbody>
    </table>
  );
}

/** 渲染一行并回传 spy。`models` 缺省为空（＝还没拉到候选）。 */
function renderRow(opts: RowProps) {
  const onBind = vi.fn();
  const onNeedModels = vi.fn();
  const { rerender } = render(rowEl(opts, onBind, onNeedModels));
  return {
    onBind,
    onNeedModels,
    /** 模拟「服务端数据变了 ⇒ 父组件重渲染」（真机里就是 `reload()` 之后那一下） */
    rerender: (next: RowProps) => rerender(rowEl(next, onBind, onNeedModels)),
  };
}

/** 取服务商下拉；取不到直接抛人话（`noUncheckedIndexedAccess` 下下标取值恒带 `| undefined`）。 */
function providerSelect(): HTMLSelectElement {
  const el = document.querySelectorAll('select')[0];
  if (!el) throw new Error('没找到服务商下拉');
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe('RoleRow — 模型候选', () => {
  it('★ 有候选 ⇒ 渲染成下拉，且候选就是该服务商真实返回的模型', () => {
    renderRow({ modelsMap: { 'openai-default': ['agnes-2.5-flash', 'agnes-2.5-pro'] } });
    const options = Array.from(document.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toContain('agnes-2.5-flash');
    expect(options).toContain('agnes-2.5-pro');
    // 不是输入框（老板要的就是"直接用选项选"）
    expect(document.querySelector('input[placeholder="手填模型名"]')).toBeNull();
  });

  it('★ 空模型 = 「用默认模型」，**不许**被当成自定义（否则每个留空的角色都多一个手填框）', () => {
    // 首轮实测逮到的真 bug：`!models.includes('')` 恒为 true ⇒ 留空的角色被判成"自定义"，
    // 下拉显示成「自定义…」而不是「（用默认模型）」，还凭空多出一个空的输入框。
    renderRow({ modelsMap: { 'openai-default': ['agnes-2.5-flash'] }, initialModel: '' });
    const select = document.querySelector('select.settings-model-select') as HTMLSelectElement;
    expect(select.value).toBe(''); // 落在「（用默认模型）」那一项上
    expect(document.querySelector('input[placeholder="手填模型名"]')).toBeNull();
  });

  it('★ 当前值不在候选里 ⇒ 按「自定义」渲染并显示手填框（不许静默显示第一项）', () => {
    // 库里存着 'legacy-model'，而候选列表里没有它 —— 最典型的"设置页说谎"场景
    renderRow({ modelsMap: { 'openai-default': ['agnes-2.5-flash'] }, initialModel: 'legacy-model' });
    const input = document.querySelector('input[placeholder="手填模型名"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.value).toBe('legacy-model'); // 用户看到的就是库里那个值，不是被顶掉的第一项
  });

  it('★ 选「自定义…」才出现手填框；手填后保存的是手填值', () => {
    const { onBind } = renderRow({ modelsMap: { 'openai-default': ['agnes-2.5-flash'] } });
    // 初始：值是空串 ⇒ 命中「（用默认模型）」那一项，没有手填框
    expect(document.querySelector('input[placeholder="手填模型名"]')).toBeNull();

    const select = document.querySelector('select.settings-model-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '__custom__' } });
    const input = document.querySelector('input[placeholder="手填模型名"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'my-own-model' } });

    fireEvent.click(screen.getByText('保存'));
    expect(onBind).toHaveBeenCalledWith('openai-default', 'my-own-model');
  });

  it('★ 选「（用默认模型）」保存空串（与「一键默认设置」同一口径）', () => {
    const { onBind } = renderRow({
      modelsMap: { 'openai-default': ['agnes-2.5-flash'] },
      initialModel: 'agnes-2.5-flash',
    });
    const select = document.querySelector('select.settings-model-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getByText('保存'));
    // 空串 = 留空 ⇒ 由平台默认模型决定（服务端已放行；`router.test.ts` 有对应锁）
    expect(onBind).toHaveBeenCalledWith('openai-default', '');
  });

  it('★ 候选为空 ⇒ 退化成纯输入框，不把用户锁死', () => {
    renderRow({ modelsMap: { 'openai-default': [] } });
    expect(document.querySelector('select.settings-model-select')).toBeNull();
    expect(document.querySelector('input[placeholder="模型名（没拉到候选列表，可手填）"]')).not.toBeNull();
  });
});

describe('RoleRow — 按需拉候选', () => {
  it('★ 换到「没拉过」的服务商 ⇒ 触发 onNeedModels（否则那一列永远没有选项）', () => {
    const { onNeedModels } = renderRow({ modelsMap: { 'openai-default': ['a'] } });
    fireEvent.change(providerSelect(), { target: { value: 'p-mine' } });
    expect(onNeedModels).toHaveBeenCalledWith('p-mine');
  });

  it('★ 换到「已问过但没拉到」的服务商 ⇒ 不重复打上游（空数组也算问过了）', () => {
    const { onNeedModels } = renderRow({ modelsMap: { 'openai-default': ['a'], 'p-mine': [] } });
    fireEvent.change(providerSelect(), { target: { value: 'p-mine' } });
    expect(onNeedModels).not.toHaveBeenCalled();
  });
});

describe('RoleRow — ★★ 服务端值变了要跟着走（真机探针逮到的真 bug）', () => {
  const MODELS = { 'openai-default': ['agnes-2.5-flash'], 'p-mine': ['agnes-2.5-pro'] };

  it('★★ 父组件换 initialProvider/initialModel 重渲染 ⇒ 行上必须跟着变', () => {
    // 现象（2026-09-21 真机实测，`tools/probes/settings-platform-cdp.mjs` A9d）：
    //   点「一键默认设置」，顶部绿色提示说「已一键配好 8 个角色：走免费通道，用 agnes-2.5-flash」，
    //   而下面那张绑定表里「讲解」那一行**仍显示旧服务商 + 旧模型**（探针假上游 / agnes-2.5-pro）
    //   ——服务端明明已经改了。用户看到的是**"点了没反应"**，接着他会去手改，把刚配好的覆盖掉。
    // 根因：`useState(initialProvider)` 只在**挂载时**取一次值，而父组件给的 key 是固定的
    //   `key={r.role}`（`SettingsView.tsx`），所以 `reload()` 换了 props 也换不掉行内的 state。
    //   ★ 这个缺陷 jsdom 单测在"不 rerender"的写法下**永远看不见**，只有真机上点一下才现形。
    // 修法：把 props 当**真相源**而不是初始值（见 `RoleRow.tsx` 里那段 useEffect）。
    const { rerender } = renderRow({
      modelsMap: MODELS,
      initialProvider: 'p-mine',
      initialModel: 'agnes-2.5-pro',
    });
    expect(providerSelect().value).toBe('p-mine');

    // 模拟「一键默认设置」落库后父组件 `reload()` —— 服务端现在说：平台通道 + 留空
    rerender({ modelsMap: MODELS, initialProvider: 'openai-default', initialModel: '' });

    expect(providerSelect().value).toBe('openai-default');
    const modelSelect = document.querySelector('select.settings-model-select') as HTMLSelectElement | null;
    if (!modelSelect) throw new Error('没找到模型下拉');
    expect(modelSelect.value).toBe(''); // 落在「（用默认模型）」上，不再显示旧模型
    // 旧模型名不在新候选里 ⇒ 不许被判成"自定义"而多冒一个手填框（那会显得像没配成功）
    expect(document.querySelector('input[placeholder="手填模型名"]')).toBeNull();
  });

  it('★ 服务端说"还没绑服务商"（空串）时，不把用户正在选的服务商顶回第一个', () => {
    // "没绑"和"换了"是两回事：若空串也回落成 providers[0]，用户切到「我的中转」后
    // 被一次无关的 reload 打回「默认服务商」，会觉得"选了没用"。
    const { rerender } = renderRow({
      modelsMap: MODELS,
      initialProvider: 'p-mine',
      initialModel: '',
    });
    rerender({ modelsMap: MODELS, initialProvider: '', initialModel: '' });
    expect(providerSelect().value).toBe('p-mine');
  });
});
