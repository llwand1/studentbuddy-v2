import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNarrow } from '../lib/use-narrow';
import { getPreview, subscribePreview } from '../lib/preview-store';
import { useSources } from '../lib/sources-store';
import { useVideoRoute } from '../lib/video-route-store';

const key = (narrow: boolean) => `sb:reading:share:${narrow ? 'mobile' : 'desktop'}`;
const clamp = (value: number) => Math.max(20, Math.min(80, value));
function saved(narrow: boolean): number {
  try {
    const value = Number(localStorage.getItem(key(narrow)));
    if (Number.isFinite(value) && value >= 20 && value <= 80) return value;
  } catch { /* A denied preference store must not prevent reading. */ }
  return narrow ? 50 : 40;
}

/** Resize mounted reading surfaces without replacing their scroll, draft or quiz state. */
export function ReadingSplit() {
  const narrow = useNarrow();
  const sources = useSources();
  const video = useVideoRoute();
  const preview = useSyncExternalStore(subscribePreview, getPreview, getPreview);
  const visible = Boolean(preview || video.open || (sources.open && sources.items.length));
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const valueRef = useRef(saved(narrow));
  const [value, setValue] = useState(valueRef.current);
  useLayoutEffect(() => {
    valueRef.current = saved(narrow);
    setValue(valueRef.current);
  }, [narrow]);
  useLayoutEffect(() => {
    ref.current?.parentElement?.style.setProperty('--reading-share', `${value}%`);
  }, [value, visible, narrow]);
  const change = (next: number): void => {
    const parent = ref.current?.parentElement;
    const box = parent?.getBoundingClientRect();
    const size = box ? (narrow ? box.height : box.width) : 0;
    const composer = parent?.querySelector('.chat-composer-wrap')?.getBoundingClientRect().height ?? 0;
    const heading = parent?.querySelector('.chat-head')?.getBoundingClientRect().height ?? 0;
    const chatMin = narrow ? composer + heading + 92 : 230;
    const max = size > 0 ? Math.min(80, Math.max(50, (size - chatMin - 12) / size * 100)) : 80;
    const min = size > 0 ? Math.max(20, Math.min(45, (narrow ? 150 : 230) / size * 100)) : 20;
    valueRef.current = Math.max(min, Math.min(max, clamp(next)));
    setValue(valueRef.current);
  };
  const remember = (): void => {
    try { localStorage.setItem(key(narrow), String(valueRef.current)); } catch { /* Optional preference. */ }
  };
  const move = (x: number, y: number): void => {
    const box = ref.current?.parentElement?.getBoundingClientRect();
    if (!box) return;
    const size = narrow ? box.height : box.width;
    if (size <= 0) return;
    const next = (narrow ? y - box.top : box.right - x) / size * 100;
    change(next);
  };
  if (!visible) return null;
  return <div ref={ref} className="reading-split" role="separator" tabIndex={0}
    aria-label="调整资料与对话的占比" aria-orientation={narrow ? 'horizontal' : 'vertical'}
    aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(value)} aria-valuetext={`资料 ${Math.round(value)}%，对话 ${100 - Math.round(value)}%`}
    title="拖动调整资料与对话的占比；方向键微调，Home 复原"
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      dragging.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }}
    onPointerMove={(event) => { if (dragging.current === event.pointerId) move(event.clientX, event.clientY); }}
    onPointerUp={(event) => {
      if (dragging.current !== event.pointerId) return;
      dragging.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      remember();
    }}
    onPointerCancel={() => { dragging.current = null; remember(); }}
    onLostPointerCapture={() => { dragging.current = null; }}
    onKeyDown={(event) => {
      const increase = narrow ? 'ArrowDown' : 'ArrowLeft';
      const decrease = narrow ? 'ArrowUp' : 'ArrowRight';
      if (![increase, decrease, 'Home'].includes(event.key)) return;
      event.preventDefault();
      change(event.key === 'Home' ? (narrow ? 50 : 40) : value + (event.key === increase ? 5 : -5));
      remember();
    }}><span aria-hidden="true" /></div>;
}
