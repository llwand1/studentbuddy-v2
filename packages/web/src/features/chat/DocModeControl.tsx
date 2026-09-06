/**
 * DocModeControl — 文档模式控件（挂在 composer 上方）。
 * 三态齐备（ADR-5）：未载入（只有按钮）｜载入中（按钮变「载入中…」并禁用）｜
 * 已载入（pill：文件名 · 字数 · 超长标记 · 清除）。
 * 正文只随会话存服务端，刷新后靠 GET meta 复原——长资料也没必要反复过网络。
 */
import { useEffect, useState } from 'react';
import { DocIcon } from '../../components/icons';
import { api, type DocMeta } from '../../lib/api';
import { MAX_DOC_CHARS } from '@sb/shared';

/** 服务端 express.json 上限 2mb，留余量给 JSON 转义膨胀 */
const MAX_FILE_BYTES = 1_900_000;
const ACCEPT = '.txt,.md,.markdown,text/plain,text/markdown';

const num = (n: number): string => n.toLocaleString('zh-CN');

export function DocModeControl({ sessionId, blocked }: { sessionId: string | null; blocked: boolean }) {
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');

  // 切会话即重取：上一会话的资料绝不串台（会话绑定语义）
  useEffect(() => {
    setMeta(null);
    setPanelOpen(false);
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
      setPanelOpen(false);
      setHint('已载入，从下一轮回答起生效');
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

  const overCap = text.length > MAX_DOC_CHARS;

  return (
    <div className="chat-doc">
      <div className="chat-doc-bar">
        <button
          className="chat-quiz-btn"
          title="文档模式：为本会话载入一篇 txt/md 资料，回答优先依据它（超长资料按提问检索段落；每次一份，可替换/清除）"
          disabled={!sessionId || busy || blocked}
          onClick={() => setPanelOpen((v) => !v)}
        >
          <DocIcon /> {busy ? '载入中…' : meta ? '换资料' : '文档模式'}
        </button>
        {meta && (
          <span className="chat-doc-pill">
            <span className="chat-doc-name" title={meta.name}>
              {meta.name}
            </span>
            <span className="chat-doc-chars">{num(meta.chars)} 字</span>
            {meta.truncated && <span className="chat-doc-warn">超 {num(MAX_DOC_CHARS)} 字 · 按提问检索段落</span>}
            <button className="chat-doc-clear" disabled={busy} onClick={() => void clear()} title="清除本会话资料">
              清除
            </button>
          </span>
        )}
        {hint && <span className="chat-doc-hint">{hint}</span>}
      </div>

      {panelOpen && (
        <div className="chat-doc-panel">
          <input
            className="chat-doc-name-input"
            value={name}
            placeholder="资料名称（粘贴内容时可自己起个名）"
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            className="chat-doc-text"
            value={text}
            rows={6}
            placeholder="粘贴 txt / markdown 正文…"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="chat-doc-actions">
            <span className={overCap ? 'chat-doc-count warn' : 'chat-doc-count'}>
              {num(text.length)} 字
              {overCap ? ` · 超 ${num(MAX_DOC_CHARS)} 字，将按提问检索相关段落` : ''}
            </span>
            <label className="chat-quiz-btn">
              选文件
              <input
                type="file"
                accept={ACCEPT}
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  void onPickFile(f);
                }}
              />
            </label>
            <button
              className="chat-quiz-btn"
              disabled={!text.trim() || busy}
              onClick={() => void submit(name.trim() || '粘贴资料', text)}
            >
              载入粘贴内容
            </button>
            <button className="chat-quiz-btn" onClick={() => setPanelOpen(false)}>
              收起
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
