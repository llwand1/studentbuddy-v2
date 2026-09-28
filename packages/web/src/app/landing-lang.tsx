/**
 * landing-lang — 落地页**中英切换**的底座（面向使用英语的访客）。
 *
 * ★ 范围决策（三条，2026-09-28 改口径）：
 *   ① **全局：落地页 + 应用壳框架**（老板点单「给全局加一个英文按键，不只是 hero 页有」）。
 *      Provider 因此挂在 `main.tsx` 根（`<StrictMode>` 内、`<Root/>` 外），落地页与应用壳
 *      **共用同一份状态**——不这么做就会出现「在落地页选了 EN、登录进去又变回中文」。
 *      `app/Landing.tsx` 里那层内层 Provider 已删（双层各自 `useState` ＝ 切换不同步）。
 *      **功能页文案（对话/设置/词条/卡牌/知识大陆/教练/搜索面板/PK）仍是中文**，分批推进，
 *      这是知情选择不是遗漏；壳层框架文案收在 `app/shell-copy.ts` 与 `nav.ts`。
 *   ② demo 动画帧里的示例内容**整段换英文等价物**（术语卡、考题、概念图节点），不半中半英。
 *   ③ `中文 | EN` 按钮组（落地页页眉 + 应用侧栏底部各一枚，同一个 `LangToggle`）
 *      + localStorage 记忆 + `navigator.language` 首探。
 *
 * ★★ 命名债（知情保留，别当没看见）：本模块的文件名、导出名（`LandingLangProvider` /
 *   `useLandingLang` / `LandingLang`）与记忆键（`LANDING_LANG_KEY='sb_landing_lang'`）里的
 *   `landing` 都是历史遗留——它现在是**全局**语言底座。改名要牵动 25 个文件的 import 与
 *   ~40 处引用（`world/*` 7 个、`demo/*` 7 个、`hero/*`、`landing-copy.ts`、
 *   `components/DemoLoginButton.tsx`、3 个测试），与「加一个按钮」不成比例，留待专门批次。
 *   记忆键**值**沿用旧串 ＝ 零迁移，老访客在落地页选过的 EN 原样生效。
 *
 * ★ 为什么文案是 `{zh,en}` 成对（`Bi`）而不是两份字典文件：
 *   同一条文案的两种语言**写在同一行**，漏译在 review 时一眼可见；两份平行文件
 *   迟早漂成「改了中文忘了英文」（`landing-data.ts` 头注讲的九宫格双表教训，同一件事）。
 *
 * ★★ Context 默认值是 `zh`：所有**直挂子组件**的存量测试（TermFlowDemo/GraphDemo/
 *   PkJourney 等，都不带 Provider 渲染）因此天然落在中文口径上，一条锁都不用改语义。
 *   真实运行时永远被根上那一层 `LandingLangProvider`（`main.tsx`）罩住，默认值到不了用户浏览器。
 */
import { createContext, useContext, useState, type ReactNode } from 'react';

export type LandingLang = 'zh' | 'en';

/** 一条文案的两种语言。字段用 `zh`/`en` 裸取值（`t.zh`），不做函数——少一层间接 */
export type Bi = { zh: string; en: string };

/** 记忆键（全局共用一份）。`sb_` 前缀与本仓 cookie（`sb_sid`）同族；键名里的 landing 见上面命名债 */
export const LANDING_LANG_KEY = 'sb_landing_lang';

/** 只认 'zh' / 'en' 两个值——别人往 localStorage 里塞脏值时按「没存过」处理 */
function readStored(): LandingLang | null {
  try {
    const s = window.localStorage.getItem(LANDING_LANG_KEY);
    return s === 'zh' || s === 'en' ? s : null;
  } catch {
    return null; // 隐私模式等 storage 不可用场景：按首探走
  }
}

/** 首探优先级：手动选过的记忆 > 浏览器语言。记忆在，就再不让自动判定插手 */
export function initialLandingLang(): LandingLang {
  const stored = readStored();
  if (stored) return stored;
  const nav = typeof navigator === 'undefined' ? '' : navigator.language ?? '';
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

type LangState = { lang: LandingLang; setLang: (l: LandingLang) => void };

const LandingLangContext = createContext<LangState>({ lang: 'zh', setLang: () => undefined });

export function LandingLangProvider({ children }: { children: ReactNode }) {
  const [lang, set] = useState<LandingLang>(initialLandingLang);
  const setLang = (l: LandingLang) => {
    set(l);
    try {
      window.localStorage.setItem(LANDING_LANG_KEY, l);
    } catch {
      // 存不进去（隐私模式）只意味着下次访问回落到浏览器语言判定，本次会话内切换照常生效
    }
  };
  return <LandingLangContext.Provider value={{ lang, setLang }}>{children}</LandingLangContext.Provider>;
}

export function useLandingLang(): LangState {
  return useContext(LandingLangContext);
}

const OPTIONS: Array<{ v: LandingLang; label: string }> = [
  { v: 'zh', label: '中文' },
  { v: 'en', label: 'EN' },
];

/** 页眉那两个小按钮。**各语言永远用自己的名字写自己**（中文/English 惯例：语言名不翻译） */
export function LangToggle() {
  const { lang, setLang } = useLandingLang();
  return (
    <span className="landing-lang" role="group" aria-label="语言 / Language">
      {OPTIONS.map((o) => (
        <button
          key={o.v}
          type="button"
          className={o.v === lang ? 'landing-lang-btn landing-lang-on' : 'landing-lang-btn'}
          aria-pressed={o.v === lang}
          onClick={() => setLang(o.v)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}
