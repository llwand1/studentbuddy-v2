import { expect, it } from 'vitest';
import { parsePluginManifest, parsePluginRepositories } from './plugin-ecosystem.js';
const manifest = {schemaVersion:1,id:'reader',name:'Reader',version:'1.0.0',description:'Remote reader',transport:'streamable-http',endpoint:'https://mcp.example.com/mcp',tools:['read','read']};
it('parses credential-free remote declarations and deduplicates explicit tools',()=>{
  expect(parsePluginManifest(manifest).tools).toEqual(['read']);
});
it.each(['http://mcp.example.com/mcp','https://user:secret@mcp.example.com/mcp','https://127.0.0.1/mcp','https://mcp.example.com/mcp?token=secret','https://mcp.example.com/mcp#fragment'])('rejects unsafe endpoint %s',endpoint=>{
  expect(()=>parsePluginManifest({...manifest,endpoint})).toThrow();
});
it.each([{command:'node'},{headers:{Authorization:'secret'}},{trusted:true},{schemaVersion:2},{id:'../escape'},{tools:[]},{tools:Array(33).fill('read')}])('rejects unsupported or executable declarations %j',patch=>{
  expect(()=>parsePluginManifest({...manifest,...patch})).toThrow();
});
it('normalizes only explicit repository identities; no wildcards, traversal or malformed scopes',()=>{
  expect(parsePluginRepositories(['Owner/Repo','owner/repo'])).toEqual(['owner/repo']);
  for(const bad of [['*/*'],['owner/repo/other'],['owner/..'],['https://github.com/a/b'],Array(51).fill('a/b')]) expect(()=>parsePluginRepositories(bad)).toThrow();
});

