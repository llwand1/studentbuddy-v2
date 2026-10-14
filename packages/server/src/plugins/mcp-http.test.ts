import { beforeEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
const wire = vi.hoisted(()=>({request:vi.fn(),resolve:vi.fn(),mode:'json',status:200,hold:false,
  calls:[] as Array<{options:RequestOptions;body:Record<string,unknown>}>}));
vi.mock('node:https',()=>({default:{request:wire.request}}));
vi.mock('../search/ssrf-guard.js',()=>({resolveSafeAddress:wire.resolve}));
import { McpHttpClient, pluginAddress } from './mcp-http.js';
import { GITHUB_PLUGIN } from './catalog.js';
const token='github_pat_private_token_1234567890';
beforeEach(()=>{
  wire.mode='json';wire.status=200;wire.hold=false;wire.calls=[];wire.resolve.mockReset().mockResolvedValue('140.82.112.6');
  wire.request.mockReset().mockImplementation((_url:URL, options:RequestOptions, callback:(res:IncomingMessage)=>void)=>{
    const emitter=new EventEmitter();
    const req=Object.assign(emitter,{end:(payload?:string)=>{
      const body=payload ? JSON.parse(payload) as Record<string,unknown> : {};
      wire.calls.push({options,body});
      if (wire.hold && body.method==='tools/call') {options.signal?.addEventListener('abort',()=>emitter.emit('error',new Error('abort')),{once:true});return;}
      queueMicrotask(()=>{
        const res=Object.assign(new PassThrough(),{statusCode:wire.status,headers:{'content-type':wire.mode==='sse' ? 'text/event-stream' : 'application/json','mcp-session-id':'session-1'}});
        if(options.method==='DELETE') {res.statusCode=405;callback(res as unknown as IncomingMessage);res.end();return;}
        if(body.method==='notifications/initialized') {res.statusCode=202;callback(res as unknown as IncomingMessage);res.end();return;}
        let result:Record<string,unknown>;
        const params=body.params as Record<string,unknown>;
        if(body.method==='initialize') result={protocolVersion:'2025-06-18',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}};
        else if(body.method==='tools/list') result=params.cursor ? {tools:[{name:'list_issues',inputSchema:{type:'object'}}]} :
          {tools:[{name:'get_file_contents',description:'Read',inputSchema:{type:'object'}},{name:'create_issue',inputSchema:{type:'object'}}],nextCursor:'page-2'};
        else result={content:[{type:'text',text:'Read '+token},{type:'image',data:'never forward'}]};
        callback(res as unknown as IncomingMessage);
        const response=JSON.stringify({jsonrpc:'2.0',id:body.id,result});
        if(wire.mode==='oversize') res.end('x'.repeat(1024*1024+1));
        else if(wire.mode==='mismatch') res.end(JSON.stringify({jsonrpc:'2.0',id:'wrong',result:{}}));
        else if(wire.mode==='sse') {
          res.write('data: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{}})+'\r\n\r\n');
          res.write('data: '+response.slice(0,17));res.end(response.slice(17)+'\r\n\r\n');
        } else res.end(response);
      });
    }});
    return req as unknown as ClientRequest;
  });
});
it.each(['json','sse'])('negotiates %s, propagates session/version, pages/filter tools, redacts and ignores non-text blocks',async mode=>{
  wire.mode=mode;
  const client=new McpHttpClient(GITHUB_PLUGIN,token,AbortSignal.timeout(3000));await client.initialize();
  expect((await client.tools()).map(t=>t.name)).toEqual(['get_file_contents','list_issues']);
  expect(await client.call('get_file_contents',{owner:'a',repo:'b'})).toMatchObject({ignoredBlocks:1});
  expect((await client.call('get_file_contents',{})).text).not.toContain(token);
  const request=wire.calls.find(x=>x.body.method==='tools/call')!;
  expect(request.options.headers).toMatchObject({'X-MCP-Readonly':'true','Mcp-Session-Id':'session-1','MCP-Protocol-Version':'2025-06-18',Authorization:'Bearer '+token});
  expect(request.options.family).toBe(4);
  expect(request.options.lookup).toBeTypeOf('function');
  await client.close();expect(wire.calls.at(-1)?.options.method).toBe('DELETE');
});
it.each([401,403,429,302,404])('reports HTTP %i without replay or following redirects',async status=>{
  wire.status=status;const client=new McpHttpClient(GITHUB_PLUGIN,token,AbortSignal.timeout(3000));
  await expect(client.initialize()).rejects.toThrow();expect(wire.calls).toHaveLength(1);
});
it.each(['oversize','mismatch'])('rejects %s wire responses',async mode=>{
  wire.mode=mode;await expect(new McpHttpClient(GITHUB_PLUGIN,token,AbortSignal.timeout(3000)).initialize()).rejects.toThrow();
});
it('aborts active calls instead of leaving a pending response',async()=>{
  const ctrl=new AbortController(),client=new McpHttpClient(GITHUB_PLUGIN,token,ctrl.signal);await client.initialize();
  wire.hold=true;const pending=client.call('get_file_contents',{});const caught=pending.catch(e=>e as Error);
  await vi.waitFor(()=>expect(wire.calls.some(x=>x.body.method==='tools/call')).toBe(true));ctrl.abort();expect(await caught).toBeInstanceOf(Error);
});
it('rejects non-public endpoints and pins DNS rather than checking then re-resolving',async()=>{
  for(const url of ['http://mcp.example.com/mcp','https://127.0.0.1/mcp','https://mcp.local/mcp','https://mcp.example.com/mcp?token=bad']) await expect(pluginAddress(url)).rejects.toThrow();
  wire.resolve.mockResolvedValue('100.64.1.2');await expect(pluginAddress(GITHUB_PLUGIN.endpoint)).rejects.toThrow('非公网');
  wire.resolve.mockResolvedValue('::');await expect(pluginAddress(GITHUB_PLUGIN.endpoint)).rejects.toThrow('非公网');
});
it('honors cancellation during DNS resolution before opening any TLS connection',async()=>{
  wire.resolve.mockImplementation(()=>new Promise<string>(()=>{}));
  const ctrl=new AbortController(),client=new McpHttpClient(GITHUB_PLUGIN,token,ctrl.signal);
  const pending=client.initialize().catch(e=>e as Error);ctrl.abort();
  expect(await pending).toBeInstanceOf(Error);expect(wire.calls).toEqual([]);
});

