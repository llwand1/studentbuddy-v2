/**
 * SaveAsDocButton —— 资料架上的「存为资料」：把**当前这条**资料的网页变成本会话的学习资料
 * （契约 `docs/DOC-RAG-SPEC.md` §10、`docs/SOURCE-TRACE-SPEC.md` §8.2）。
 *
 * 为什么这个按钮该长在这里：学习者在架子上翻 AI 读过的几条，看到「就它了，以后都照这页答」——
 * 这是整个流程里**唯一**他已经明确选中某一页的时刻。让他回去把网址复制到 composer 的面板里，
 * 等于把一个已经做完的选择又拆成三步。
 *
 * 两件事刻意**不做**：
 * ① 不碰资料架本身。架子是「AI 这一轮读了什么」（编号即身份、随消息落库），
 *    存为资料是「以后都按这页答」（会话级、每次一份）——两个语义，按钮只写后者。
 * ② 不自己持有资料状态。写完只喊一声 `notifyDocChanged()`，由 composer 上的 pill 去重取——
 *    服务端是唯一真相源，这里再存一份就得自己维护一致性（见 `doc-events.ts`）。
 *
 * 视频条目不显示本按钮：视频没有可抓的正文，抓回来的是播放页外壳，存了也是一份空资料。
 */
import { useState } from 'react';
import type { SourceItem } from '@sb/shared';
import { api } from '../../lib/api';
import { notifyDocChanged } from '../chat/doc-events';

type Phase = { k: 'idle' } | { k: 'busy' } | { k: 'done'; site: string } | { k: 'error'; msg: string };

export function SaveAsDocButton({ sessionId, item }: { sessionId: string; item: SourceItem }) {
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });

  // 视频存不出正文（见文件头②）；没有会话 id 时也无处可存
  if (item.kind === 'video' || !sessionId) return null;

  const run = async (): Promise<void> => {
    setPhase({ k: 'busy' });
    try {
      const r = await api.doc.setFromUrl(sessionId, item.url);
      notifyDocChanged();
      setPhase({ k: 'done', site: r.source.site });
    } catch (e) {
      // ★ 失败要留在屏上让人看见，不恢复成 idle 装作没发生过（ADR-5 不静默）
      setPhase({ k: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  };

  const label = phase.k === 'busy' ? '抓取中…' : phase.k === 'done' ? '已存为资料' : phase.k === 'error' ? '没存成' : '存为资料';
  const title =
    phase.k === 'error'
      ? `没存成：${phase.msg}（点一下重试）`
      : phase.k === 'done'
        ? `已把「${phase.site}」这一页设为本会话资料，之后的回答与出题都以它为准`
        : '把这一页抓成本会话资料：之后的回答与出题都以它为准（每次一份，会替换当前资料）';

  return (
    <button
      className={`sb-browser-btn src-save-doc${phase.k === 'done' ? ' done' : ''}${phase.k === 'error' ? ' failed' : ''}`}
      disabled={phase.k === 'busy'}
      onClick={() => void run()}
      title={title}
    >
      {label}
    </button>
  );
}
