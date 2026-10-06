import { useCallback, useRef } from 'react';
import type { SseEvent } from '@sb/shared';

/** done 后 GrillMe 仍会下发收尾工具步骤，步骤可展示但不能把输入区再次锁住。 */
export function useRoundActivity(setBusy: (busy: boolean) => void) {
  const ended = useRef(false);
  return useCallback((event: SseEvent) => {
    if (event.type === 'round-start') {
      ended.current = false;
      setBusy(true);
    } else if (event.type === 'done' || event.type === 'chat-error') {
      ended.current = true;
    } else if (!ended.current && ['token', 'step', 'tasks'].includes(event.type)) {
      setBusy(true);
    }
  }, [setBusy]);
}
