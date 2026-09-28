/**
 * app/LandingPv — 落地页页眉的「看 PV」入口与弹层播放（2026-09-28）。
 *
 * ★ 为什么是弹层，不是嵌进首屏：首屏那块画布是可交互的序章（玩法演示），视频铺上去会盖掉它；
 *   宣传片是「坐下来看」的内容，弹层更合适，也不打乱冒险录的章节顺序。
 * ★ 首屏不变重：弹层关着时**根本不渲染 `<video>`**——片子二十多兆，挂在首屏就是让每个访客
 *   都先付这笔流量，哪怕他从不点它。
 * ★ 片子是站点静态目录里的普通文件（`public/media/`），构建后即站点根下的 `/media/…`。
 * ★ 弹层必须经 `createPortal` 挂到 `document.body`：页眉 `.landing-top` 带 `backdrop-filter`，
 *   浏览器给它造了一个**包含块**，`position: fixed` 的遮罩留在页眉里就只盖得住那条顶栏
 *   （2026-09-28 真机核验实测：遮罩只有 1440×108，点空白处命中的是 hero 而非遮罩）。
 *   这是层叠规则，不是样式漏写——单测看不见几何，只有挂到 body 才彻底躲开。
 *   CSS 变量都在 `:root`（styles/tokens.css）上，挂到 body 照样继承，不必补一份 token。
 * ★ 纯演示内容：不读写用户数据，也不上报播放行为。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PV } from './landing-copy';
import { useLandingLang } from './landing-lang';

/** 构建后它就是站点根下的静态文件（`public/media/studentbuddy-pv.mp4`） */
export const PV_SRC = '/media/studentbuddy-pv.mp4';

export function LandingPv() {
  const { lang } = useLandingLang();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 打开期间：Esc 可关 + 锁住背景滚动；关闭时把页面恢复到打开前的状态
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    boxRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button type="button" className="landing-ghost" onClick={() => setOpen(true)} aria-haspopup="dialog">
        {PV.open[lang]}
      </button>
      {/* 遮罩：点它＝关闭；层内点哪都不关（stopPropagation 只拦这一层）。
          挂到 body 是为了逃开页眉 backdrop-filter 造出的包含块（见文件头）。 */}
      {open &&
        createPortal(
          <div className="landing-pv-mask" onClick={() => setOpen(false)}>
            <div
              className="landing-pv-box"
              role="dialog"
              aria-modal="true"
              aria-label={PV.title[lang]}
              tabIndex={-1}
              ref={boxRef}
              onClick={(e) => e.stopPropagation()}
            >
              <video className="landing-pv-video" src={PV_SRC} controls autoPlay playsInline />
              <div className="landing-pv-bar">
                <span className="landing-pv-title">{PV.title[lang]}</span>
                <button type="button" className="landing-ghost" onClick={() => setOpen(false)}>
                  {PV.close[lang]}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}