import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { MAX_CHAT_IMAGES } from '@sb/shared';
import { hasHost } from '../float/float-view';
import { consumeDesktopFocus, discardDesktopCapture, OPEN_COMPOSER, requestDesktopCapture, watchDesktopInput, type DesktopInputState } from './desktop-input';
import './desktop-capture.css';

export function DesktopCaptureEntry() {
  return hasHost() ? <button type="button" className="reading-tool desktop-capture-entry" aria-label="截图提问" title="框选本机画面，预览后提问" onClick={requestDesktopCapture}>▣</button> : null;
}
/** Screenshot acceptance only edits the local draft. It never calls send/vision/upload. */
export function DesktopComposerBridge({ input, setInput, inputRef, attachments, setAttachments }: {
  input: string; setInput: (v: string) => void; inputRef: RefObject<HTMLTextAreaElement>;
  attachments: Array<{dataUrl: string; name?: string}>;
  setAttachments: Dispatch<SetStateAction<Array<{dataUrl: string; name?: string}>>>;
}) {
  const [pending, setPending] = useState<DesktopInputState>({ capture: null, focus: false, error: '' });
  const [question, setQuestion] = useState('');
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => watchDesktopInput(value => {
    setPending(value);
    if (value.focus) {
      consumeDesktopFocus();
      window.dispatchEvent(new Event(OPEN_COMPOSER));
      if (!value.capture && !value.error) window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }), [inputRef]);
  useEffect(() => {
    if (!pending.capture) return;
    setQuestion(''); dialog.current?.focus();
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); discardDesktopCapture(); }
      if (e.key === 'Tab') {
        const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea') ?? []), first = items[0], last = items.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [pending.capture?.id]);
  const capture = pending.capture;
  return <>
    {pending.error && <p className="desktop-error" role="alert">{pending.error}<button type="button" onClick={discardDesktopCapture}>关闭</button></p>}
    {capture && <div className="desktop-capture-backdrop"><section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="截图预览" className="desktop-capture-preview">
      <header><h2>截图预览</h2><button type="button" aria-label="取消截图" onClick={discardDesktopCapture}>×</button></header>
      <img src={capture.dataUrl} alt="本机框选截图预览" />
      <p>{capture.width} × {capture.height} · 仅在本机预览</p>
      <label>想问什么？<textarea aria-label="截图问题" value={question} onChange={e=>setQuestion(e.target.value)} placeholder="例如：解答截图中的题目 / 解释这个报错" /></label>
      <p>放入输入框后，仍需点击「发送」才会把截图交给你配置的视觉模型；不会持续采集屏幕。</p>
      {attachments.length >= MAX_CHAT_IMAGES && <p role="alert">附件已满，请取消并移除一张图片后重新截图。</p>}
      <footer><button type="button" onClick={discardDesktopCapture}>取消</button><button type="button" onClick={requestDesktopCapture}>重新截图</button>
        <button type="button" disabled={attachments.length >= MAX_CHAT_IMAGES} onClick={()=>{
          setAttachments(a=>a.length < MAX_CHAT_IMAGES ? [...a,{dataUrl:capture.dataUrl,name:capture.name}] : a);
          setInput(input.trim() ? input + (question.trim() ? '\n' + question.trim() : '') : question.trim() || '请解答这张截图中的问题。');
          discardDesktopCapture(); window.dispatchEvent(new Event(OPEN_COMPOSER)); window.requestAnimationFrame(()=>inputRef.current?.focus());
        }}>放入输入框</button></footer>
    </section></div>}
  </>;
}
