/**
 * use-guide-cap —— 组件向引路灯「报名」的 hook（契约 `docs/GUIDE-SPEC.md` §3）。
 *
 * 传 `null` ＝ 此刻做不了（不登记）；传函数 ＝ 此刻能做。登记只在「哪些动作可用」这件事变化时重做，
 * 处理器本身走 ref 读最新——组件每次渲染都会产生新的箭头函数，若也算变化，注册表会每次渲染都抖一下。
 * 卸载时自动注销。
 */
import { useEffect, useRef } from 'react';
import { GUIDE_KINDS, type GuideKind } from '@sb/shared';
import { registerGuideCap, type GuideHandler } from './guide-store';

export type GuideCaps = Partial<Record<GuideKind, GuideHandler | null | undefined>>;

export function useGuideCaps(caps: GuideCaps): void {
  const ref = useRef(caps);
  ref.current = caps;
  const active = GUIDE_KINDS.filter((k) => !!caps[k]);
  const key = active.join('|');
  useEffect(() => {
    const offs = active.map((k) => registerGuideCap(k, (text) => ref.current[k]?.(text)));
    return () => offs.forEach((off) => off());
    // active 由 key 唯一决定：只在可用集合变化时重登记
  }, [key]);
}

export function useGuideCap(kind: GuideKind, handler: GuideHandler | null | undefined): void {
  useGuideCaps({ [kind]: handler });
}
