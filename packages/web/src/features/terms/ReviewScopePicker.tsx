/**
 * ReviewScopePicker — 复习范围选择器（v28 选择式复习，契约 `docs/EBBINGHAUS-SPEC.md` §9）。
 *
 * 背景：词条库是 AI 从**全部对话**里自动抽的，里面混着娱乐/闲聊词条（实测老板库里
 * `general` 域 66 条既有「阈值」「认知偏差」也有「谐音梗」「二创」）⇒ 复习队列被稀释，
 * 真正要背的术语淹在里面。故复习改成**选择式**：只有点过的领域/词条才复习。
 *
 * ★ 本组件只管**领域级**（一键全开/全关）；**词条级**的勾选放在词条列表行上
 *   （那里才是"我看到了这条词条"的地方）。两者共用同一个端点，见 `api-terms-review.ts`。
 * ★ 领域开关的语义是**一键全开 / 一键全关**（服务端会一并清掉该域内词条的覆盖位）：
 *   若只切开关而保留反选，被反选过的词条不会跟着开，"一键开启"就名不副实
 *   ——用户会以为按钮坏了。故本组件按"没全选就补全、已全选就清空"来点，与三态显示一致。
 * ★ 空领域（`count === 0`）不列出来：没有词条就没有可复习的东西，列出来只是噪音
 *   （但它们在领域管理面板里仍然存在，见 `DomainBar`）。
 * ★ 每点一次都会显示**清零条数**：纳入范围会触发「清零重来」（老板 2026-09-18 拍板），
 *   这是**不可撤销**的进度损失，必须让用户看见它发生在几条词条上，不能默默清掉。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';

/** 选择器只需要这几个字段（`DomainsResponse.domains` 的子集） */
interface ScopeRow {
  domain: string;
  count: number;
  reviewEnabled: boolean;
  reviewCount: number;
}

/**
 * 领域三态：**全选 / 部分 / 未选**。
 * ★ 判据是 `reviewCount` 与 `count` 的差，**不是** `reviewEnabled`：
 *   开关开着但被逐条反选时是"部分"，开关关着却单独勾了几条时也是"部分"——
 *   只看开关会把这个状态误报成"未选"，用户就找不到自己刚勾的那几条了。
 */
function triState(r: ScopeRow): 'all' | 'some' | 'none' {
  if (r.count > 0 && r.reviewCount >= r.count) return 'all';
  return r.reviewCount > 0 ? 'some' : 'none';
}

export function ReviewScopePicker({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<ScopeRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const s = await api.terms.domains();
    setRows(s.domains.filter((d) => d.count > 0));
  }, []);

  useEffect(() => {
    void reload()
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [reload]);

  const toggle = async (r: ScopeRow) => {
    if (busy) return;
    setBusy(r.domain);
    setMsg('');
    const target = triState(r) !== 'all'; // 没全选 → 补成全选；已全选 → 清空
    try {
      const res = await api.terms.scopeDomain(r.domain, target);
      setMsg(
        target
          ? `「${r.domain}」已纳入 ${r.count} 条词条` +
              (res.resetCount > 0 ? `，其中 ${res.resetCount} 条的复习进度清零重来` : '')
          : `「${r.domain}」已整域移出复习范围`,
      );
      await reload();
      onChanged?.();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '操作失败');
    } finally {
      setBusy(null);
    }
  };

  const total = rows.reduce((n, r) => n + r.count, 0);
  const chosen = rows.reduce((n, r) => n + r.reviewCount, 0);

  return (
    <div className="rv-scope">
      <div className="rv-scope-head">
        <b>复习范围</b>
        <span className="rv-scope-hint">
          {loading ? '正在读领域…' : `已纳入 ${chosen} / ${total} 条`}
        </span>
      </div>
      <p className="rv-scope-tip">
        只复习你勾选的领域和词条——点领域是**整域开关**，单个词条请在下方词条列表里逐条勾。
      </p>

      <div className="rv-scope-list">
        {rows.map((r) => {
          const st = triState(r);
          return (
            <button
              key={r.domain}
              className={`rv-scope-row rv-scope-${st}`}
              disabled={busy === r.domain}
              title={
                st === 'all'
                  ? '点一下：整个领域移出复习范围'
                  : `点一下：把「${r.domain}」的 ${r.count} 条词条全部纳入复习`
              }
              onClick={() => void toggle(r)}
            >
              <i className={`rv-tri rv-tri-${st}`} />
              <span className="rv-scope-name">{r.domain}</span>
              <span className="rv-scope-num">
                {r.reviewCount} / {r.count}
              </span>
            </button>
          );
        })}
        {!loading && rows.length === 0 && <p className="rv-scope-tip">词条库还是空的，先去攒几条词条。</p>}
      </div>

      {msg && <div className="rv-scope-msg">{msg}</div>}
    </div>
  );
}
