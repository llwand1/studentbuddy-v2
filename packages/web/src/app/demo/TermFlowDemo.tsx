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
 */
import { useEffect, useState, type ReactElement } from 'react';

/** 每字毫秒数：贴近真机流式输出的观感（比真人打字快、比瞬间刷出慢） */
const SPEED = 42;
/** 首帧的前摇：让用户先看到提问、再看到回答开始流 */
const LEAD = 260;

const USER_ASK = '什么是梯度下降?';
const SEG1 = '梯度下降是一种按负梯度方向迭代更新参数的优化方法。';
const SEG2 = '学习率决定每步幅度，学习率太大就会震荡。';

/** 词条库里已有的词（演示口径）。第二个「学习率」会走复现样式，与首现区分 */
const TERMS = ['梯度下降', '学习率'];

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
function useTyping(active: boolean, text: string, delay: number): number {
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
      }, SPEED);
    }, delay);
    return () => {
      window.clearTimeout(to);
      window.clearInterval(iv);
    };
  }, [active, text, delay]);
  return n;
}

export function TermFlowDemo({ stage }: { stage: number }) {
  const typing = stage === 0;
  const n1 = useTyping(typing, SEG1, LEAD);
  const n2 = useTyping(typing, SEG2, LEAD + SEG1.length * SPEED + 160);
  const shown = highlightShown([SEG1.slice(0, n1), SEG2.slice(0, n2)], TERMS);
  const review = stage >= 3;

  return (
    <>
      <div className={review ? 'ld-layer ld-hide' : 'ld-layer'}>
        <div className="ld-row">
          <div className="ld-ask">{USER_ASK}</div>
        </div>
        <div className="ld-reply">
          <div className="ld-who">studentbuddy</div>
          <p className="ld-text">
            {shown[0]}
            {shown[1]}
            {typing && <span className="ld-caret" />}
          </p>
        </div>

        <div className={stage >= 1 ? 'ld-hover ld-on' : 'ld-hover'}>
          <div className="ld-hover-head">
            <span className="ld-hover-term">梯度下降</span>
            <span className="ld-hover-domain">机器学习</span>
            <span className="ld-hover-used">已用 7 次</span>
          </div>
          <p className="ld-hover-def">沿负梯度方向迭代更新参数，使目标函数逐步下降的优化方法。</p>
          <div className="ld-hover-acts">
            <span>纳入复习</span>
            <span>打开词条库</span>
          </div>
        </div>

        <div className={stage >= 2 ? 'ld-chip ld-on' : 'ld-chip'}>
          <span className="ld-chip-dot" />
          <span className="ld-chip-text">已自动存入词条库</span>
          <span className="ld-chip-num">新增 2 个</span>
        </div>
      </div>

      <div className={review ? 'ld-layer ld-review ld-on' : 'ld-layer ld-review'}>
        <div className="ld-rv-label">词条库 · 待复习</div>
        <div className="ld-flipwrap">
          <div className={stage >= 4 ? 'ld-flip ld-flipped' : 'ld-flip'}>
            <div className="ld-face ld-front">
              <span className="ld-due">1 天没复习</span>
              <span className="ld-front-term">梯度下降</span>
              <span className="ld-front-hint">先想一遍，再翻牌</span>
            </div>
            <div className="ld-face ld-back">
              <p className="ld-back-def">沿负梯度方向迭代更新参数，使目标函数逐步下降的优化方法。</p>
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
              <div className="ld-back-note">第 2 次复查 · 4 天后 · 进度只增不减</div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
