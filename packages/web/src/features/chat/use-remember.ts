/**
 * useRemember —— 「存入记忆」动作域（忆域 v2：把最近对话里的重要术语交给 AI 抽取入库）。
 *
 * 从 ChatView 原样搬出（行为逐字不变）：ChatView 贴 320 行红线，引路灯接入要腾地方。
 * 材料由调用方给（`getMaterial`：ChatView 从消息尾部拼装，与出题用同一份），本 hook 不持消息引用。
 */
import { useState } from 'react';
import { api } from '../../lib/api';

export function useRemember(sessionId: string | null, getMaterial: () => string) {
  const [remembering, setRemembering] = useState(false);
  const [rememberMsg, setRememberMsg] = useState('');

  const rememberTerms = async (): Promise<void> => {
    if (!sessionId || remembering) return;
    const material = getMaterial();
    if (!material.trim()) return;
    setRemembering(true);
    setRememberMsg('');
    try {
      const r = await api.terms.extract(material, sessionId);
      setRememberMsg(r.added > 0 ? `已存入 ${r.added} 个词条，后续回答会优先使用` : '这段对话没有值得记住的术语');
    } catch {
      setRememberMsg('存入失败，请稍后重试');
    } finally {
      setRemembering(false);
      window.setTimeout(() => setRememberMsg(''), 3000);
    }
  };

  return { remembering, rememberMsg, rememberTerms };
}
