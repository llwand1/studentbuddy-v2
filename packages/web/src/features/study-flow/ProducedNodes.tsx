/**
 * ProducedNodes — 一次学习流运行**产出的知识节点**（契约 `docs/STUDY-FLOW-SPEC.md` §6；
 * 「向 AI 追问」一节见 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §6）。
 *
 * ★ 为什么这里也要有「向 AI 追问」（词条卡上已经有了）：
 *   学习流跑完，用户看到的第一批词条就在这儿——文案是「这次运行产出了 N 个词条」。
 *   这时想深挖某一个，不该逼他先切到词条库再把它找出来；就地追问，走的是与词条卡
 *   **完全同一条**分叉路径（同一个 `POST /api/sessions/:id/fork`，服务端零新增）。
 *
 * ★ 与词条卡的四处不同，每处都是本页的真实约束（不是随手改的）：
 *  ① **父会话是「那一次运行的会话」**（`flow_run.session_id`），不是"当前打开的会话"。
 *     学习流页与对话页是两个视图，用户此刻并没有"正在看的对话"⇒ 走 `FollowUpAction`
 *     的第三个参数显式给，不依赖 App 的 `currentId`。
 *  ② **只对 `term` 节点开放追问**：`term_library` 有 `source_session_id`，服务端据此才能
 *     把追问的产出连到这颗星心；`note`/`concept` 没有对应词条行 ⇒ 追问会开出一个
 *     **连不上任何边**的会话（静默空转）。ADR-5 不许静默，所以那种节点连按钮都不给。
 *     当前 `emitTermNodes` 只产 `term` 节点，这条判据是**为将来**立的
 *     （`STUDY-FLOW-SPEC` §7 记着 `note`/`turn` 的定位锚点还没接，别等它真出现才补）。
 *  ③ 一次运行最多列 12 个（沿用本块原实现的上限），追问入口只挂在列出来的那些上。
 *  ④ 未注入 `onFollowUp`、或这次运行没有关联会话时，**不给任何可点控件**
 *     （同词条卡的既有手法：点了才报错的假控件不如不画）。
 *
 * ★ 成功不刷文案：此刻 App 已切到新会话、本组件随页面卸载，写了也看不见
 *   （同 `TermCard.askFollowUp` 的三态口径；失败必须说出来，人还留在原页面）。
 */
import { useState } from 'react';
import type { KnowledgeNode } from '@sb/shared';
import { ApiError, type FollowUpAction } from '../../lib/api';

/** 一次运行最多列出的产出节点（沿用原 `RunPanel` 内联实现的上限，避免一屏几百个 chip） */
export const PRODUCED_SHOWN_MAX = 12;

/**
 * 追问输入框的长度上限（字符）。
 * ★ 与词条卡的 200 保持一致（`TermCard` 的 `FOLLOW_UP_INPUT_MAX`）：两者是**同一个控件
 *   在两种位置**，上限不同会让人以为"能打多少字取决于从哪儿点进来"。
 * ★ 用 `maxLength` 而不是"事后截断"：`maxLength` 是打不进第 N+1 个字（当场就知道到头），
 *   截断则是**静默吃掉用户打的字**。
 */
export const FOLLOW_UP_INPUT_MAX = 200;

export function ProducedNodes({
  nodes,
  sessionId,
  onFollowUp,
  onGoGraph,
}: {
  nodes: KnowledgeNode[];
  /** 产出这些节点的会话（`flow_run.session_id`）；null ＝ 没有会话可挂，追问不给入口 */
  sessionId: string | null;
  onFollowUp?: FollowUpAction;
  onGoGraph?: () => void;
}) {
  /** 当前选中的节点 id。选中才展开输入框，再点一次收起（同词条卡"点开才操作"的分寸） */
  const [selId, setSelId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // 没有产出就整块不渲染（原 `RunPanel` 的 `length > 0 &&` 判据挪到这里，行为不变）
  if (nodes.length === 0) return null;

  const shown = nodes.slice(0, PRODUCED_SHOWN_MAX);
  /** 选中的节点必须**仍在 `shown` 里**：运行详情会随重跑/回读刷新，旧 id 可能已经不在了 */
  const sel = shown.find((n) => n.id === selId) ?? null;
  /** 三个条件全真才给控件（见文件头 ②④）：注入了动作 ＋ 有父会话 ＋ 这个节点是词条 */
  const canAsk = onFollowUp !== undefined && sessionId !== null;

  const pick = (id: string) => {
    setErr('');
    setSelId(id === selId ? null : id);
    // ★ 换一个词条就**清空草稿**：输入框此刻讲的是另一个词，留着上一个词的问题最容易误发
    setText('');
  };

  const ask = async (): Promise<void> => {
    if (busy || !sel || !onFollowUp || !sessionId) return;
    setBusy(true);
    setErr('');
    try {
      // 留空 ⇒ `undefined`（交给服务端补 `defaultFollowUpQuestion` 的默认问法），不送空串
      await onFollowUp(sel.refText, text.trim() || undefined, sessionId);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '追问没有开起来');
      setBusy(false); // 只在失败时复位：成功时本组件已被切走的新会话卸载，复位等于往空气里写状态
    }
  };

  return (
    <div className="fl-produced">
      <span className="fl-panel-hint">
        这次运行产出了 {nodes.length} 个{canAsk ? '词条，点一个可以直接向 AI 追问' : '知识节点'}：
      </span>

      <div className="fl-produced-list">
        {shown.map((n) =>
          canAsk && n.kind === 'term' ? (
            <button
              key={n.id}
              type="button"
              className={n.id === selId ? `fl-produced-item ${n.kind} on` : `fl-produced-item ${n.kind}`}
              onClick={() => pick(n.id)}
            >
              {n.refText}
            </button>
          ) : (
            <span key={n.id} className={`fl-produced-item ${n.kind}`}>
              {n.refText}
            </span>
          ),
        )}
      </div>

      {sel && onFollowUp && sessionId && (
        <div className="fl-fu">
          <input
            className="fl-fu-in"
            placeholder="想问这个词条什么？（留空用默认问法）"
            value={text}
            maxLength={FOLLOW_UP_INPUT_MAX}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter 直接发起（单行输入框里回车本来就没有别的用途）；要长问题切到新会话接着打
              if (e.key === 'Enter') {
                e.preventDefault();
                void ask();
              }
            }}
          />
          <button
            type="button"
            className="fl-btn primary"
            disabled={busy}
            title="另开一条对话专门深挖这个词条；回答里出现的词条会自动连到知识图上"
            onClick={() => void ask()}
          >
            {busy ? '开新对话…' : '向 AI 追问'}
          </button>
        </div>
      )}

      {err && <p className="fl-err">{err}</p>}

      {canAsk && (
        <p className="fl-panel-hint">
          追问会单开一条对话（带上这次学习的上下文）：AI 回复里抽到的词条会自动与它连线，回知识图就能看到。
        </p>
      )}

      {onGoGraph && (
        <button className="fl-btn" onClick={onGoGraph}>
          去知识图看它们的关系
        </button>
      )}
    </div>
  );
}
