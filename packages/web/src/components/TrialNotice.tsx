/**
 * TrialNotice — 侧栏底部常驻的线上版定位提醒。
 *
 * 口径两条：线上版主要用来演示功能和尝试，不建议长期使用；
 * 长期使用建议本地安装包版，体验更好。
 *
 * 链接指向与 `app/Landing.tsx` 的 GitHub 横幅**同一个目标**（README 快速开始）——
 * 下载引导只能有一个入口口径，两处各指一个地址迟早漂开。
 * 挂在侧栏（登录后才存在的主壳）而不是落地页：会「长期使用线上」的人都在应用里，
 * 提醒只说给未登录的人看等于没提醒。
 */
import { useLandingLang } from '../app/landing-lang';
import { SHELL } from '../app/shell-copy';
import './trial-notice.css';

const LOCAL_BUILD_URL = 'https://github.com/llwand1/studentbuddy-v2#快速开始';

export function TrialNotice() {
  /** 提醒文案跟着全局语言走（词表见 app/shell-copy.ts）。
   *  ★ EN 串尾那一个空格是故意的：英文在链接前必须留白，中文不留——故空格只放在 en 侧 */
  const { lang } = useLandingLang();
  return (
    <p className="sb-trial-notice">
      {SHELL.trialPrefix[lang]}
      <a href={LOCAL_BUILD_URL} target="_blank" rel="noreferrer noopener">
        {SHELL.trialLink[lang]}
      </a>
    </p>
  );
}
