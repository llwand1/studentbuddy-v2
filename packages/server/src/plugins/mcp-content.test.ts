import { expect, it } from 'vitest';
import { mcpTextContent } from './mcp-content.js';
it('keeps the actual GitHub embedded README text, not only its successful-download note',()=>{
  const result=mcpTextContent({content:[{type:'text',text:'successfully downloaded text file (SHA: fixture)'},
    {type:'resource',resource:{uri:'repo://owner/repo/README.md',mimeType:'text/markdown',text:'# README\nactual file contents'}}]});
  expect(result.ignoredBlocks).toBe(0);expect(result.chunks.join('\n')).toContain('actual file contents');
});
it('never follows URI-only resources, resource links, image blocks or decodes binary blobs',()=>{
  const result=mcpTextContent({content:[{type:'resource_link',uri:'https://secret.invalid/file'},
    {type:'resource',resource:{uri:'file:///C:/secret'}},{type:'resource',resource:{uri:'x',blob:'binary'}},
    {type:'resource',resource:{uri:'x',text:'ambiguous',blob:'binary'}},{type:'image',data:'image'}]});
  expect(result).toEqual({chunks:[],ignoredBlocks:5});
});
