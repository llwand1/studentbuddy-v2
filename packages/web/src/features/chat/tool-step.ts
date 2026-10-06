/** 工具终态带来的页面副作用；步骤配对仍由纯函数 step-fold 负责。 */
import type { SseEvent } from '@sb/shared';
import { refreshExamScope } from '../exam/useExamScope';
import { foldStepEvent, type ToolStep } from './step-fold';

export function applyToolStep(steps: ToolStep[], event: Extract<SseEvent, { type: 'step' }>, now: number): ToolStep[] {
  if (event.tool === 'update_exam_scope' && event.status === 'done') void refreshExamScope(true);
  return foldStepEvent(steps, event, now);
}
