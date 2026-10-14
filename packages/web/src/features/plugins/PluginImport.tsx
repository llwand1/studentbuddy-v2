import { useState } from 'react';
import { parsePluginManifest } from '@sb/shared';
import { pluginApi } from './plugin-api';
const SAMPLE = JSON.stringify({schemaVersion:1,id:'my-plugin',name:'我的远程插件',version:'1.0.0',
  description:'我明确选择的 MCP 服务',transport:'streamable-http',endpoint:'https://mcp.example.com/mcp',tools:['lookup']},null,2);
export function PluginImport({onChange}: {onChange:()=>Promise<void>}) {
  const [text,setText] = useState(''), [ack,setAck] = useState(false), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const submit = async() => {
    if (!ack || busy) return;
    setBusy(true);setError('');
    try {
      const manifest = parsePluginManifest(JSON.parse(text) as unknown);
      await pluginApi.import(manifest);setText('');setAck(false);await onChange();
    } catch(e) {setError(e instanceof Error ? e.message : '导入失败');}
    finally {setBusy(false);}
  };
  return <details className="plugin-import">
    <summary>添加第三方插件（导入 JSON 声明）</summary>
    <p className="settings-hint">本版支持公网 HTTPS Streamable HTTP，不安装或运行第三方脚本。声明只列出你允许调用的工具；连接测试不执行工具，实际调用逐次确认。</p>
    <details><summary>查看声明格式示例</summary><pre>{SAMPLE}</pre></details>
    <label className="plugin-label">插件 JSON
      <textarea rows={8} value={text} disabled={busy} onChange={e=>setText(e.target.value)} aria-label="插件 JSON 声明" spellCheck={false} />
    </label>
    <label className="plugin-ack"><input type="checkbox" checked={ack} disabled={busy} onChange={e=>setAck(e.target.checked)} />
      我认识该服务，知道配置的 Token 仅发送给该端点，第三方工具不保证只读。</label>
    <button className="settings-add" disabled={busy || !text.trim() || !ack} onClick={()=>void submit()}>{busy ? '导入中…' : '导入插件（默认停用）'}</button>
    {error && <p role="alert" className="plugin-error">{error}</p>}
  </details>;
}

