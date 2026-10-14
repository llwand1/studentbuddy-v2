import { objectValue } from '@sb/shared';
/** Consume only text already in the response. A URI is never a fetch instruction. */
export function mcpTextContent(result: Record<string, unknown>): { chunks: string[]; ignoredBlocks: number } {
  const chunks: string[] = []; let ignoredBlocks = 0;
  for (const item of Array.isArray(result.content) ? result.content : []) {
    const block = objectValue(item);
    if (block.type === 'text' && typeof block.text === 'string') { chunks.push(block.text); continue; }
    if (block.type === 'resource' && block.resource && typeof block.resource === 'object' && !Array.isArray(block.resource)) {
      const resource = objectValue(block.resource);
      if (typeof resource.text === 'string' && resource.blob === undefined) {
        chunks.push('[已返回的内嵌文本资源；未访问其 URI]\n' + resource.text); continue;
      }
    }
    ignoredBlocks++;
  }
  return { chunks, ignoredBlocks };
}
