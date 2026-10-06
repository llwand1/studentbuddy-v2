import { it, expect, vi, beforeEach } from 'vitest';
import { applyToolStep } from './tool-step';
import { refreshExamScope } from '../exam/useExamScope';
vi.mock('../exam/useExamScope', () => ({ refreshExamScope: vi.fn(async () => null) }));
beforeEach(() => vi.clearAllMocks());
it('AI 保存白名单后强制刷新页面共享范围，过程卡仍正常折叠', () => {
  const steps = applyToolStep([], { type: 'step', seq: 1, sessionId: 's', tool: 'update_exam_scope', status: 'done', detail: '已保存' }, 100);
  expect(refreshExamScope).toHaveBeenCalledWith(true); expect(steps[0]?.status).toBe('done');
});
it('挂起或其他工具不刷新范围', () => {
  applyToolStep([], { type: 'step', seq: 1, sessionId: 's', tool: 'update_exam_scope', status: 'running' }, 100);
  applyToolStep([], { type: 'step', seq: 2, sessionId: 's', tool: 'search_web', status: 'done' }, 100);
  expect(refreshExamScope).not.toHaveBeenCalled();
});
