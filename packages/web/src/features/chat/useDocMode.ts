/**
 * useDocMode — 文档模式的状态与动作（契约 `docs/DOC-RAG-SPEC.md`）。
 *
 * 从 `DocModeControl` 拆出来的原因：该控件的**触发器**要搬进输入框的「+」菜单
 * （老板「把这几个功能按键集中放进一个可展开折叠的按键」），而它的**面板与 pill 得留在
 * composer 上方**——pill 是会话状态（载入的哪篇、多少字、可清除），藏进折叠菜单等于把状态藏了。
 * 触发器与面板分居两处，但状态必须同一份，于是状态升到这里，两边各自消费。
 *
 * 正文只随会话存服务端，刷新后靠 GET meta 复原——长资料也没必要反复过网络。
 */
import { useEffect, useState } from 'react';
import { api, type DocMeta } from '../../lib/api';
import { splitDocName } from './doc-name';
import { MAX_DOC_CHARS } from '@sb/shared';

/** 服务端 express.json 上限 2mb，留余量给 JSON 转义膨胀 */
const MAX_FILE_BYTES = 1_900_000;

/** 文件选择框的 accept（面板渲染 `<input type="file">` 时用） */
export const ACCEPT = '.txt,.md,.markdown,text/plain,text/markdown';

export interface DocMode {
  meta: DocMeta | null;
  /** 拆分后的文件名（base 给状态摘要，ext 单独渲染成小字） */
  dn: { base: string; ext: string } | null;
  name: string;
  setName: (v: string) => void;
  text: string;
  setText: (v: string) => void;
  busy: boolean;
  hint: string;
  overCap: boolean;
  submit: (docName: string, docText: string) => Promise<void>;
  onPickFile: (file: File | undefined) => Promise<void>;
  clear: () => Promise<void>;
}

/**
 * `onLoaded` 在**载入成功后**调用（面板据此收起）；失败不调——带错误的提示留在屏上给人看，
 * 面板一收就什么都看不见了（ADR-5 不静默）。
 *
 * 不接 `blocked` 参数：动作禁用是**调用方**的事（菜单项上判 `ready !== 'open'`），
 * 状态层再做一道闸只会有两个真相源——第一版就写了这个参数，发现它一次都没被读。
 */
export function useDocMode(sessionId: string | null, onLoaded?: () => void): DocMode {
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');

  // 切会话即重取：上一会话的资料绝不串台（会话绑定语义）
  useEffect(() => {
    setMeta(null);
    setHint('');
    if (!sessionId) return;
    let alive = true;
    api.doc
      .get(sessionId)
      .then((r) => {
        if (alive) setMeta(r.doc);
      })
      .catch(() => {
        // 会话不存在或服务未就绪：按「未载入」呈现，不弹错误（ADR-4）
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const submit = async (docName: string, docText: string): Promise<void> => {
    if (!sessionId || busy) return;
    setBusy(true);
    setHint('');
    try {
      const r = await api.doc.set(sessionId, docName, docText);
      setMeta(r.doc);
      setName('');
      setText('');
      setHint('已载入，从下一轮回答起生效');
      onLoaded?.();
    } catch (e) {
      setHint(`载入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onPickFile = async (file: File | undefined): Promise<void> => {
    if (!file || !sessionId) return;
    if (file.size > MAX_FILE_BYTES) {
      setHint('文件过大：正文上限约 1.9 MB');
      return;
    }
    const body = await file.text();
    await submit(file.name, body);
  };

  const clear = async (): Promise<void> => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      await api.doc.clear(sessionId);
      setMeta(null);
      setHint('已清除资料');
    } catch (e) {
      setHint(`清除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return {
    meta,
    dn: meta ? splitDocName(meta.name) : null,
    name,
    setName,
    text,
    setText,
    busy,
    hint,
    overCap: text.length > MAX_DOC_CHARS,
    submit,
    onPickFile,
    clear,
  };
}
