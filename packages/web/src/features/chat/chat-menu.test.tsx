// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { buildComposerMenuItems } from './chat-menu';
it('keeps a focused menu; desktop screenshot/reading are actions, removed duplicates stay absent', () => {
  const deps={sessionId:'s',blocked:false,quizzing:false,onQuiz:vi.fn(),online:true,setOnline:vi.fn(),mixTip:'',grillMe:false,setGrillMe:vi.fn(),desktop:true,onReader:vi.fn(),onCapture:vi.fn()};
  const items=buildComposerMenuItems(deps);
  expect(items.map(t=>t.key)).toEqual(['quiz','online','grill','reader','capture']);
  for(const item of items)if(item.kind==='action')item.onClick();
  expect(deps.onReader).toHaveBeenCalledOnce();expect(deps.onCapture).toHaveBeenCalledOnce();
  expect(buildComposerMenuItems({...deps,desktop:false}).map(t=>t.key)).toEqual(['quiz','online','grill']);
  expect(buildComposerMenuItems({...deps,blocked:true}).filter(t=>t.kind==='action').every(t=>t.disabled)).toBe(true);
});
