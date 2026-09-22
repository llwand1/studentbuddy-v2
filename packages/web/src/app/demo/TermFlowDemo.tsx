/**
 * TermFlowDemo — 词条流程的**过程式演示**（落地页 hero 右侧那一块）。
 *
 * ★ 为什么演示的是这个：老板 2026-09-20 认定「词条才是项目的核心功能」，而落地页首屏
 *   原先一个字都没提。本演示把 README「忆 · AI 词条库」里最独特的三件事按时间顺序演出来：
 *   ① 正文里词条库已有的词**自动标出**（首现实线 / 复现虚点线，两档线型是真实口径）
 *   ② 悬停出速览卡（释义 / 领域 / 已用次数，动作可直接回写词库）
 *   ③ 到期进复习队列、**先翻牌自测再看释义**（1/2/4/7/15/30/60 七个节点）
 *
 * ★ 全部前端写死（老板 2026-09-20 拍板）：落地页的职责是讲清楚，不是当 demo 环境——
 *   连后端跑会让未登录访客看到一个需要服务端配合、还可能报错的演示。
 *
 * ★ 打字机是**真的逐字推进**（setTimeout 42ms/字 ≈ 真机 SSE 流式的观感），不是 CSS 宽度
 *   裁剪：中文的 `em` 宽度随字体浮动，用 `steps()` + 固定宽度会在换行/异体字下错位，
 *   而逐字渲染与字体无关。帧时长已在 registry 里按 `25 字 × 42ms + 尾停留` 反算过。
 *
 * ★ 2026-09-22 中英切换批：示例内容整段换成英文等价物（不是逐字对译，是同一场景的
 *   英文学习对话）。两条口径：
 *   ① EN 每字速度 `SPEED.en = 21ms`——真机 SSE 吐英文时每包平均多近一倍的字符，
 *     逐字 42ms 反而是给英文装了台慢放机；减半才与产品实际观感同量级（货不对板纪律）。
 *   ② 两语共用帧时长 ⇒ **每语的揭示耗时必须 < 首帧 ms**，这条由 `LandingLang.test.tsx`
 *     的预算锁机器守住（导出 `SPEED/LEAD/TAIL/SEG1/SEG2` 就是为了让测试能算这笔账）。
 */
import { useEffect, useState, type ReactElement } from 'react';
import type { Bi, LandingLang } from '../landing-lang';
import { useLandingLang } from '../landing-lang';

/** 每字毫秒数：贴近真机流式输出的观感（比真人打字快、比瞬间刷出慢）。见头注 ★① 的 EN 口径 */
export const SPEED: Record<LandingLang, number> = { zh: 42, en: 21 };
/** 首帧的前摇：让用户先看到提问、再看到回答开始流 */
export const LEAD = 260;
/** 两段之间的换气间隔（160ms），也是预算公式的一项 */
export const TAIL = 160;

export const ASK: Bi = { zh: '什么是梯度下降?', en: 'What is gradient descent?' };
export const SEG1: Bi = { zh: '梯度下降是一种按负梯度方向迭代更新参数的优化方法。', en: 'Gradient descent steps down the gradient.' };
export const SEG2: Bi = {
  zh: '学习率决定每步幅度，学习率太大就会震荡。',
  en: 'The learning rate sets each stride — a big learning rate oscillates.',
};

/** 词条库里已有的词（演示口径）。第二个「学习率」会走复现样式，与首现区分 */
export const TERMS: Record<LandingLang, string[]> = {
  zh: ['梯度下降', '学习率'],
  en: ['Gradient descent', 'learning rate'],
};

const HOVER: { term: Bi; domain: Bi; used: Bi; def: Bi; toReview: Bi; openLib: Bi } = {
  term: { zh: '梯度下降', en: 'Gradient descent' },
  domain: { zh: '机器学习', en: 'Machine learning' },
  used: { zh: '已用 7 次', en: 'Used 7 times' },
  def: { zh: '沿负梯度方向迭代更新参数，使目标函数逐步下降的优化方法。', en: 'The optimizer that updates parameters along the negative gradient, lowering the objective step by step.' },
  toReview: { zh: '纳入复习', en: 'Add to review' },
  openLib: { zh: '打开词条库', en: 'Open library' },
};

const CHIP: { filed: Bi; added: Bi } = {
  filed: { zh: '已自动存入词条库', en: 'Auto-filed into your term library' },
  added: { zh: '新增 2 个', en: '2 new' },
};

const REVIEW: { label: Bi; due: Bi; hint: Bi; note: Bi } = {
  label: { zh: '词条库 · 待复习', en: 'Library · Up for review' },
  due: { zh: '1 天没复习', en: 'Not reviewed for 1 day' },
  hint: { zh: '先想一遍，再翻牌', en: 'Recall it first, then flip' },
  note: { zh: '第 2 次复查 · 4 天后 · 进度只增不减', en: 'Check #2 · in 4 days · progress never rolls back' },
};

/**
 * 把「已显示的部分」按词条切分并打标。纯函数、无副作用——每次渲染重建 `seen`，
 * 故「首现 vs 复现」的判定是确定性的（不依赖渲染次数，热更新/重渲染都不会漂）。
 *
 * ★ 只在词**完整显示**后才命中：打字到「梯度」时不算命中——半个词不该被标成词条。
 */
export function highlightShown(parts: string[], terms: string[]): ReactElement[][] {
  const seen = new Set<string>();
  return parts.map((text, pi) => {
    const out: ReactElement[] = [];
    let buf = '';
    let i = 0;
    while (i < text.length) {
      const hit = terms.find((t) => t.length > 0 && text.startsWith(t, i));
      if (hit) {
        if (buf) {
          out.push(<span key={`t${pi}-${i}`}>{buf}</span>);
          buf = '';
        }
        const again = seen.has(hit);
        seen.add(hit);
        out.push(
          <span className={again ? 'ld-mark ld-mark-again' : 'ld-mark'} key={`m${pi}-${i}`}>
            {hit}
          </span>,
        );
        i += hit.length;
      } else {
        buf += text[i];
        i += 1;
      }
    }
    if (buf) out.push(<span key={`t${pi}-end`}>{buf}</span>);
    return out;
  });
}

/** 逐字揭示：`active` 为真时从 0 字起播（重播即是把 active 从假切回真） */
function useTyping(active: boolean, text: string, delay: number, speed: number): number {
  const [n, setN] = useState(active ? 0 : text.length);
  useEffect(() => {
    if (!active) {
      setN(text.length);
      return;
    }
    setN(0);
    let i = 0;
    let iv = 0;
    const to = window.setTimeout(() => {
      iv = window.setInterval(() => {
        i += 1;
        setN(i);
        if (i >= text.length) window.clearInterval(iv);
      }, speed);
    }, delay);
    return () => {
      window.clearTimeout(to);
      window.clearInterval(iv);
    };
  }, [active, text, delay, speed]);
  return n;
}

export function TermFlowDemo({ stage }: { stage: number }) {
  const { lang } = useLandingLang();
  const seg1 = SEG1[lang];
  const seg2 = SEG2[lang];
  const typing = stage === 0;
  const n1 = useTyping(typing, seg1, LEAD, SPEED[lang]);
  const n2 = useTyping(typing, seg2, LEAD + seg1.length * SPEED[lang] + TAIL, SPEED[lang]);
  const shown = highlightShown([seg1.slice(0, n1), seg2.slice(0, n2)], TERMS[lang]);
  const review = stage >= 3;

  return (
    <>
      <div className={review ? 'ld-layer ld-hide' : 'ld-layer'}>
        <div className="ld-row">
          <div className="ld-ask">{ASK[lang]}</div>
        </div>
        <div className="ld-reply">
          <div className="ld-who">studentbuddy</div>
          <p className="ld-text">
            {shown[0]}
            {shown[1]}
            {typing && <span className="ld-caret" />}
          </p>
          {/* ★ 速览卡必须挂在 `.ld-reply` **里面**：它靠 `top:100%` 贴在正文下方，而
              `.ld-reply` 才是那个 `position:relative` 的包含块。放在外层时百分比是对着
              整层（302px）算的，卡片会掉到演示窗外面被 `overflow:hidden` 裁掉——
              2026-09-21 落地对战批实测量到它 y=537、舞台底边 527，也就是「悬停出速览卡」
              那一帧从来没把卡画出来过（说明写在 demo.css 的 `.ld-hover` 上）。 */}
          <div className={stage >= 1 ? 'ld-hover ld-on' : 'ld-hover'}>
            <div className="ld-hover-head">
              <span className="ld-hover-term">{HOVER.term[lang]}</span>
              <span className="ld-hover-domain">{HOVER.domain[lang]}</span>
              <span className="ld-hover-used">{HOVER.used[lang]}</span>
            </div>
            <p className="ld-hover-def">{HOVER.def[lang]}</p>
            <div className="ld-hover-acts">
              <span>{HOVER.toReview[lang]}</span>
              <span>{HOVER.openLib[lang]}</span>
            </div>
          </div>
        </div>

        <div className={stage >= 2 ? 'ld-chip ld-on' : 'ld-chip'}>
          <span className="ld-chip-dot" />
          <span className="ld-chip-text">{CHIP.filed[lang]}</span>
          <span className="ld-chip-num">{CHIP.added[lang]}</span>
        </div>
      </div>

      <div className={review ? 'ld-layer ld-review ld-on' : 'ld-layer ld-review'}>
        <div className="ld-rv-label">{REVIEW.label[lang]}</div>
        <div className="ld-flipwrap">
          <div className={stage >= 4 ? 'ld-flip ld-flipped' : 'ld-flip'}>
            <div className="ld-face ld-front">
              <span className="ld-due">{REVIEW.due[lang]}</span>
              <span className="ld-front-term">{HOVER.term[lang]}</span>
              <span className="ld-front-hint">{REVIEW.hint[lang]}</span>
            </div>
            <div className="ld-face ld-back">
              <p className="ld-back-def">{HOVER.def[lang]}</p>
              <div className="ld-bars">
                <i className="ld-bar ld-bar-on" />
                <i className="ld-bar ld-bar-on" />
                <i className="ld-bar" />
                <i className="ld-bar" />
                <i className="ld-bar" />
                <i className="ld-bar" />
                <i className="ld-bar" />
              </div>
              <div className="ld-days">
                <span>1</span>
                <span>2</span>
                <span>4</span>
                <span>7</span>
                <span>15</span>
                <span>30</span>
                <span>60</span>
              </div>
              <div className="ld-back-note">{REVIEW.note[lang]}</div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
