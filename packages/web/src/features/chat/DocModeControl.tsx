/**
 * DocModeControl — 文档模式的状态 pill 与载入面板（挂在 composer 上方）。
 *
 * 2026-09-13 改版（老板口述「把这几个功能按键集中放进一个可展开折叠的按键」）：
 * 原来那个「文档模式 / 换资料」**触发器**已搬进输入框的「+」折叠菜单，本组件只留两件
 * **不能折进菜单**的东西——
 * ① **pill**：本会话载入了哪篇、多少字、要不要按提问检索段落、可清除。这是**会话状态**，
 *    藏进菜单等于把状态藏了（与「联网开关」同一处理：动作可折叠，状态不藏）；
 * ② **面板**：粘贴正文 / 选文件的输入区，折进 168px 宽的菜单里根本没法用。
 * 触发器与面板因此分居两处，但必须共用同一份状态 ⇒ 状态升到 `useDocMode`，本组件只消费。
 *
 * 三态齐备（ADR-5）：未载入（只有 hint 位）｜载入中（`busy`：面板按钮与 pill 清除一并禁）｜
 * 已载入（pill）。正文只随会话存服务端，刷新后靠 GET meta 复原——长资料没必要反复过网络。
 */
import { MAX_DOC_CHARS } from '@sb/shared';
import { ACCEPT, type DocMode } from './useDocMode';

const num = (n: number): string => n.toLocaleString('zh-CN');

/** 面板是否展开由调用方持有：触发器在「+」菜单里，点过之后才拉得开这个面板 */
export function DocModeControl({
  doc,
  open,
  onClose,
}: {
  doc: DocMode;
  open: boolean;
  onClose: () => void;
}) {
  const { meta, dn, name, setName, text, setText, busy, hint, overCap, submit, onPickFile, clear } = doc;

  return (
    <div className="chat-doc">
      {(meta || hint) && (
        <div className="chat-doc-bar">
          {meta && dn && (
            <span className="chat-doc-pill">
              <span className="chat-doc-filename">
                <span className="chat-doc-name" title={meta.name}>
                  {dn.base}
                </span>
                {dn.ext && <span className="chat-doc-ext">{dn.ext}</span>}
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
      )}

      {open && (
        <div className="chat-doc-panel">
          <div className="chat-doc-note">
            每次一份，载入新资料会替换当前的。超过 {num(MAX_DOC_CHARS)} 字不再整篇送入模型，而是按你的提问检索相关段落来回答。
          </div>
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
            <button className="chat-quiz-btn" onClick={onClose}>
              收起
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
