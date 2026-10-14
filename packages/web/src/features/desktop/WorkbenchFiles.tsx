import { useEffect, useState } from 'react';
import type { DesktopFileEntry, DesktopWorkspaceInfo } from '@sb/shared';
import { workbenchApi } from './workbench-api';
import { onHostMessage, postToHost, hasHost } from '../float/float-view';

export function WorkbenchFiles({ workspace, onChanged }: { workspace: DesktopWorkspaceInfo; onChanged: () => void }) {
  const [root, setRoot] = useState(workspace.root), [path, setPath] = useState(workspace.root);
  const [entries, setEntries] = useState<DesktopFileEntry[]>([]), [text, setText] = useState('');
  const [opened, setOpened] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [error, setError] = useState(''), [choosing, setChoosing] = useState(false);
  useEffect(() => { setRoot(workspace.root); setPath(workspace.root); }, [workspace.root]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); onChanged(); }
  };
  const saveRoot = (value: string) => run(async () => { await workbenchApi.workspace(value); onChanged(); setNotice('工作区已更新；区外仍只有只读权。'); });
  useEffect(() => onHostMessage(message => {
    if (!choosing || !message.startsWith('sb-desktop:workspace-selected:')) return;
    setChoosing(false);
    const value = JSON.parse(message.slice('sb-desktop:workspace-selected:'.length)) as string | null;
    if (typeof value === 'string') { setRoot(value); void saveRoot(value); }
  }), [choosing]);
  const list = (value: string) => run(async () => { setPath(value); setEntries(await workbenchApi.list(value)); });
  const read = (value: string) => run(async () => {
    const file = await workbenchApi.read(value); setOpened(file.path); setText(file.text);
    setNotice(file.truncated ? '已读取前 256KB，文件较大，内容已截断。' : `已读取 ${file.bytes} 字节。`);
  });
  return <section className="wb-files">
    <p className="wb-policy">电脑文件：只读 · 工作区：可读写 · 敏感文件：每次询问<br />当前只提取文本，不运行程序或删除文件。</p>
    <label>工作区文件夹<input value={root} onChange={e => setRoot(e.target.value)} /></label>
    <div className="wb-actions"><button disabled={busy} onClick={() => void saveRoot(root)}>应用工作区</button>
      {hasHost() && <button disabled={choosing} onClick={() => { setChoosing(true); postToHost('sb-desktop:choose-workspace'); }}>选择文件夹</button>}</div>
    <label>浏览路径<input value={path} onChange={e => setPath(e.target.value)} placeholder="工作区相对路径或电脑绝对路径" /></label>
    <div className="wb-actions"><button disabled={busy} onClick={() => void list(path)}>列出目录</button><button disabled={busy} onClick={() => void read(path)}>读取文件</button><button disabled={busy} onClick={() => void list(workspace.root)}>回到工作区</button></div>
    {workspace.locations && <button disabled={busy} onClick={() => void list(workspace.locations!.desktop)}>打开桌面（只读）</button>}
    <button disabled={busy || !path.trim()} onClick={() => void run(async () => { await workbenchApi.protect(path, true); setNotice('该位置及其子文件已标为敏感，每次访问都要许可。'); })}>将此位置标为敏感</button>
    {workspace.protectedPaths?.length > 0 && <details><summary>已标记敏感位置（{workspace.protectedPaths.length}）</summary>{workspace.protectedPaths.map(p => <p key={p}>{p}<button onClick={() => void run(async () => { await workbenchApi.protect(p, false); })}>取消手动标记</button></p>)}</details>}
    {busy && <p role="status">正在处理；若需敏感文件许可，请在上方授权卡操作。</p>}
    {error && <p role="alert" className="desktop-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <ul className="wb-file-list">{entries.map(e => <li key={e.path}><button disabled={busy} onClick={() => void (e.directory ? list(e.path) : read(e.path))}>
      <span>{e.directory ? '▣' : '▤'} {e.name}</span>{e.sensitive && <small>需许可</small>}</button></li>)}</ul>
    <label>文件路径<input value={opened} onChange={e => setOpened(e.target.value)} placeholder="工作区内的文件名，例如 notes/summary.md" /></label>
    <label>文本内容<textarea className="wb-editor" value={text} onChange={e => setText(e.target.value)} spellCheck={false} /></label>
    <button disabled={busy || !opened.trim()} onClick={() => void run(async () => {
      const saved = await workbenchApi.write(opened, text); setNotice(`已写入 ${saved.bytes} 字节${saved.backup ? '，原文件已自动备份' : ''}。`);
    })}>保存到工作区</button>
    <p className="wb-policy">电脑其他位置不能保存。更改工作区不会追授正在等待的文件操作；需要重新规划。</p>
  </section>;
}
