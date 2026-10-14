import { expect, it, vi } from 'vitest';
import { GithubStdio, githubProcessEnvironment } from './github-stdio.js';
it('strips inherited credentials, host/app overrides and logs from the fixed native process', () => {
  expect(githubProcessEnvironment({PATH:'path',GITHUB_PERSONAL_ACCESS_TOKEN:'secret',GH_TOKEN:'secret',GITHUB_APP_PRIVATE_KEY:'key',GITHUB_OAUTH_CLIENT_ID:'other',MCP_LOG_FILE:'log'})).toEqual({PATH:'path'});
});
type Entry={resolve:(v:Record<string,unknown>)=>void;reject:(e:Error)=>void;clean:()=>void};
type Harness={child:{stdin:{write:ReturnType<typeof vi.fn>};kill:ReturnType<typeof vi.fn>};pending:Map<string,Entry>;buffer:string;stopped:boolean;receive:(s:string)=>void};
function harness(){
  const client=Object.create(GithubStdio.prototype) as GithubStdio;
  const h=client as unknown as Harness;
  Object.assign(h,{child:{stdin:{write:vi.fn()},kill:vi.fn()},pending:new Map(),buffer:'',stopped:false});
  return {client,h};
}
it('matches split JSON-RPC responses, ignores unknown IDs, never executes server callbacks',async()=>{
  const {client,h}=harness();const ctrl=new AbortController();const result=client.request('tools/list',{},ctrl.signal);
  const sent=JSON.parse(h.child.stdin.write.mock.calls[0]![0] as string) as {id:string};
  h.receive('{"jsonrpc":"2.0","id":"unknown","result":{}}\n');expect(h.pending.size).toBe(1);
  h.receive('{"jsonrpc":"2.0","id":"callback","method":"sampling/createMessage"}\n');
  expect(h.child.stdin.write.mock.calls[1]![0]).toContain('Host callbacks are not available');
  const msg=JSON.stringify({jsonrpc:'2.0',id:sent.id,result:{tools:[]}})+'\n';h.receive(msg.slice(0,9));h.receive(msg.slice(9));
  expect(await result).toEqual({tools:[]});expect(h.pending.size).toBe(0);
});
it('aborts individual calls, bounds unsolicited bytes and refuses requests after the transport stops',async()=>{
  const {client,h}=harness();const ctrl=new AbortController();const pending=client.request('tools/call',{},ctrl.signal);ctrl.abort();
  await expect(pending).rejects.toThrow('停止');expect(h.child.stdin.write.mock.calls[1]![0]).toContain('notifications/cancelled');
  h.receive('x'.repeat(1024*1024+1));expect(h.child.kill).toHaveBeenCalledOnce();
  await expect(client.request('tools/list',{},new AbortController().signal)).rejects.toThrow('结束');
});
it('native calls return embedded file text while still bounding output and filtering blobs',async()=>{
  const {client,h}=harness();const result=client.call('get_file_contents',{owner:'a',repo:'b',path:'README.md'},new AbortController().signal);
  const sent=JSON.parse(h.child.stdin.write.mock.calls[0]![0] as string) as {id:string};
  h.receive(JSON.stringify({jsonrpc:'2.0',id:sent.id,result:{content:[{type:'text',text:'successfully downloaded text file'},
    {type:'resource',resource:{uri:'repo://a/b/README.md',text:'actual README '+ 'x'.repeat(16000)}},{type:'image',data:'ignored'}]}})+'\n');
  const output=await result;expect(output.text).toContain('actual README');expect(output.text).toContain('截断');expect(output.text.length).toBeLessThanOrEqual(14000);expect(output.ignoredBlocks).toBe(1);
});
it('invalid matched result rejects the pending promise instead of removing its abort listener and hanging forever',async()=>{
  const {client,h}=harness();const result=client.request('tools/list',{},new AbortController().signal);
  const sent=JSON.parse(h.child.stdin.write.mock.calls[0]![0] as string) as {id:string};
  h.receive(JSON.stringify({jsonrpc:'2.0',id:sent.id,result:null})+'\n');
  await expect(result).rejects.toThrow('结束');expect(h.pending.size).toBe(0);expect(h.child.kill).toHaveBeenCalledOnce();
});
