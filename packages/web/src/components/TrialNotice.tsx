/**
 * TrialNotice — 侧栏底部常驻的线上版定位提醒（老板 2026-09-21 口述定稿）。
 *
 * 口径两条（他原话）：线上版主要用来演示功能和尝试，不建议长期使用；
 * 长期使用建议本地安装包版，体验更好。
 *
 * 链接指向与 `app/Landing.tsx` 的 GitHub 横幅**同一个目标**（README 快速开始）——
 * 下载引导只能有一个入口口径，两处各指一个地址迟早漂开。
 * 挂在侧栏（登录后才存在的主壳）而不是落地页：会「长期使用线上」的人都在应用里，
 * 提醒只说给未登录的人看等于没提醒。
 */
import './trial-notice.css';

const LOCAL_BUILD_URL = 'https://github.com/llwand1/studentbuddy-v2#快速开始';

export function TrialNotice() {
  return (
    <p className="sb-trial-notice">
      线上版用于功能演示与试用；长期使用建议装
      <a href={LOCAL_BUILD_URL} target="_blank" rel="noreferrer noopener">
        本地安装包版
      </a>
    </p>
  );
}
