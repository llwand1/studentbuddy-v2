import { useCallback, useEffect, useRef, useState } from 'react';
import { drillApi } from '../../lib/api-drill';
import type { DrillEntry, DrillPhase } from './useDrillSession';
import type { DrillAudio } from './drill-audio';

/** Lock one real save and ignore its result after the card or session has left. */
export function useDrillKeep({ open, entry, phase, onSaved, onNotice, audio }: {
  open: boolean; entry: DrillEntry | null; phase: DrillPhase;
  onSaved: (term: string) => void; onNotice: (text: string) => void; audio: DrillAudio | null;
}) {
  const [state, setState] = useState<'saving' | 'saved' | null>(null);
  const request = useRef<symbol | null>(null);
  useEffect(() => {
    setState(null);
    return () => { request.current = null; };
  }, [open, entry]);
  const keep = useCallback(() => {
    const item = entry?.newItem;
    if (!open || !item || phase !== 'reveal' || request.current) return;
    const token = Symbol('keep'); request.current = token; setState('saving');
    void drillApi.keep(item).then(result => {
      if (request.current !== token) return;
      setState('saved');
      onNotice(`「${result.term}」已收入词库${item.source === 'fallback' ? '（来自内置词池）' : ''}`);
      audio?.play('keep'); onSaved(result.term);
    }).catch((error: unknown) => {
      if (request.current !== token) return;
      request.current = null; setState(null);
      onNotice(`收入词库没成：${error instanceof Error && error.message ? error.message : '稍后再试'}`);
    });
  }, [open, entry, phase, audio, onNotice, onSaved]);
  return { keep, state, isLocked: () => request.current !== null };
}
