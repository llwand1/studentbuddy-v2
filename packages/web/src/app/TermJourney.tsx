/**
 * TermJourney — 落地页的「词条旅程」段（老板 2026-09-20 点单：核心功能没说白）。
 *
 * ★ 这段解决的是**叙事错位**：原先首屏讲「五环闭环」，但那是**结果**——任何聊天类产品都能
 *   这么说。真正的机制是：**词条是知识原子，五环只是它在不同阶段的形态**。故把 README
 *   「忆」三节里的机制按用户视角的先后顺序排成五步，每步都有代码对应：
 *     抽词 → `[TERMS]` 协议 fire-and-forget + 手动通道（README §忆·AI 词条库）
 *     高亮 → 首现实线 / 复现虚点线 + 悬浮卡（契约 TERM-HIGHLIGHT-SPEC）
 *     注入 → 加权相关性检索作第二条 system 软注入（同上）
 *     复习 → 七节点遗忘曲线 + 先还旧账 + 先翻牌（迁移 v23 / EBBINGHAUS-SPEC）
 *     沉淀 → 领域为一级实体（迁移 v19）+ 理解链（**仅部分落码**）
 *
 * ★ 2026-09-21 按老板拍板的 **B 累积回路** 重写：五步原先是五张静态卡（一段零动画的说明文），
 *   可它讲的就是「流程」——流程该按过程呈现。现在是**环**：令牌沿环走过五站，每转完一圈，
 *   中央的「已用次数」+1。它讲的是产品真正的承诺：**复利**。
 *
 * ★★ 货对板核过（老板 2026-09-21：实际效果与演示效果差别不要太大）：
 *   中央那个数不是修辞，是产品里真实存在的 `term_library.usage_count`——
 *     累加：`learning/term-usage.ts:41-57`（`countUsage` 扫本轮回复命中的词条，命中即 +1），
 *     时机：`chat/flow.ts:332`（**每轮回复结束时**，fire-and-forget，不阻塞对话），
 *     显示：`features/chat/TermCard.tsx:154`「已用 N 次」、`features/terms/TermsPage.tsx:217`。
 *   「只增不减」也逐条查过写入口：全仓只有三处写这列（上面那一处 +1、`chat/memory.ts:194` +1、
 *   `learning/tidy.ts:59-82` 合并同名词时写**各条之和**）⇒ 没有任何一条会把它调小。
 *   ★ 唯一压缩的是**时间**：真实要一轮对话才 +1，这里 2.6s 转一圈 ⇒ 页面下方明写。
 *   ★ 五站等宽也是叙事压缩（五个机制真实耗时差好几个数量级），所以**右侧清单把五步的
 *     `lead`/`desc`/落地状态一条不删地留着**——没有为动效让路删掉任何一句实话。
 *
 * ★ 计时口径：整段只有**一个时钟**（一个 setInterval 推一个 `turn`），高亮弧、令牌、
 *   清单选中行、中央计数全部由同一个 `turn` 派生 ⇒ 它们不可能互相对不上。
 *   （候选稿里弧走 13s CSS 无限转、热点走 1.8s 步进，两条独立时钟必然漂，没带过来。）
 *   `prefers-reduced-motion` 下**不挂计时器**：退化成静态五站图，信息一条不少。
 */
import { useEffect, useState } from 'react';
import { ChatIcon, DocIcon, PinIcon, ClockIcon, GraphIcon } from '../components/icons';
import { prefersReducedMotion } from './demo/useDemoPlayer';

type Step = {
  icon: typeof ChatIcon;
  no: string;
  title: string;
  lead: string;
  desc: string;
  /** 落地状态：与 README 的标注口径一致 */
  tag: string;
  /** 只有部分落码的步骤带这个标记，用于样式上弱化，避免视觉上冒充已完成 */
  partial?: boolean;
};

const STEPS: Step[] = [
  {
    icon: ChatIcon,
    no: '01',
    title: '抽词',
    lead: '对话里自动入库',
    desc: '回复后由 [TERMS] 协议异步抽取，不阻塞对话、失败降级为空；也可以手动「存入记忆」。同名词自动合并，并向模型回灌已有词表防分裂。',
    tag: '已落地',
  },
  {
    icon: DocIcon,
    no: '02',
    title: '高亮',
    lead: '正文里标出来',
    desc: '回复中命中词条库的词自动标出：首现实线、复现虚点线。悬停看释义，点开是完整卡，卡上的动作直接回写词库。',
    tag: '已落地',
  },
  {
    icon: PinIcon,
    no: '03',
    title: '注入',
    lead: '越用越容易被想起',
    desc: '回复前按子串命中、重要度、最近使用三路加权检索，命中的词条作为第二条软注入——用过的词更容易再被用上，形成正反馈。',
    tag: '已落地',
  },
  {
    icon: ClockIcon,
    no: '04',
    title: '复习',
    lead: '到期自己排队',
    desc: '七个复查节点 1/2/4/7/15/30/60 天，到期即进队列、先还旧账。复习范围按词条或领域勾选，忘了归零重来，进度只增不减。',
    tag: '已落地',
  },
  {
    icon: GraphIcon,
    no: '05',
    title: '沉淀',
    lead: '连成领域与知识网',
    desc: '领域是一级实体，改名时词条批量随迁；理解程度按 L0 直觉到 L4 迁移分级累积，让「学到哪一层」变成看得见的状态。',
    tag: '部分落地',
    partial: true,
  },
];

/** 一圈 5 站 × 2.6s。转速是压缩过的（真实要一轮对话才推进一次），页面里已如实写明 */
const STEP_MS = 2600;
/** 环半径与圆心（SVG 用户单位，与 viewBox 220×220 同坐标系；盒子再大一圈才装得下药丸） */
const R = 100;
const C = 110;
/** 起始「已用次数」：随便取一个真实词条会有的量级，不参与任何计算 */
const USED_AT = 6;

/** 五站在环上的角度：01 在正上方（-90°），顺时针每站 +72° */
const at = (i: number) => ((-90 + i * 72) * Math.PI) / 180;
const offsetX = (i: number) => Math.round(R * Math.cos(at(i)));
const offsetY = (i: number) => Math.round(R * Math.sin(at(i)));

/**
 * 高亮弧：从当前站画到下一站（72° 的圆弧，端点由圆心角算出，`A r r 0 0 1` = 顺时针）。
 * 弧本身就以正上方（01 站）为起点，所以组的旋转角只需 `turn * 72` —— 再叠一个 -90
 * 会把整条弧挪到 9 点钟方向（第一版踩过，因为 SVG 的 dash 起点在 3 点钟而这条是 path）。
 */
const ARC_PATH = `M${C} ${C - R} A${R} ${R} 0 0 1 ${C + offsetX(1)} ${C + offsetY(1)}`;

export function TermJourney() {
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (prefersReducedMotion()) return; // 静态：停在第 0 站，一条信息都不少
    const iv = window.setInterval(() => setTurn((t) => t + 1), STEP_MS);
    return () => window.clearInterval(iv);
  }, []);

  const hot = turn % STEPS.length;
  // 走完一整圈（转到下一圈的第 01 站）才算「这个词条又被用了一次」
  const used = USED_AT + Math.floor(turn / STEPS.length);

  return (
    <section className="landing-section" aria-label="词条的完整旅程">
      <h2 className="landing-h2">
        一个词条，走完<span className="landing-accent">一整套学习流程</span>
      </h2>
      <p className="landing-section-sub">
        它不在某个单独的功能页里——从你说出它的那一刻起，抽词、标注、注入、复习由系统自动接手，
        并且每转一圈都留下痕迹
      </p>

      <div className="landing-journey-loop">
        <div className="landing-orbit" aria-hidden="true">
          <svg className="landing-ring" width={2 * C} height={2 * C} viewBox={`0 0 ${2 * C} ${2 * C}`}>
            <circle className="landing-ring-bg" cx={C} cy={C} r={R} />
            {/* 整组旋转：`transform-box: view-box` 让 transform-origin 落在 viewBox 坐标上，
                否则它会按元素自己的包围盒算原点，弧就会绕着别的地方转。
                gates:style-ok —— 旋转角是 `turn` 派生的数据，不是硬编码样式 */}
            <g className="landing-ring-run" style={{ transform: `rotate(${turn * 72}deg)` }}>
              <path className="landing-ring-arc" d={ARC_PATH} />
              <circle className="landing-ring-token" cx={C} cy={C - R} r={6} />
            </g>
          </svg>
          {STEPS.map(({ title }, i) => (
            <span
              key={title}
              className={i === hot ? 'landing-orbit-node hot' : 'landing-orbit-node'}
              /* gates:style-ok —— 五站在环上的坐标由三角函数算出，是数据不是样式表能表达的 */
              style={{ left: `calc(50% + ${offsetX(i)}px)`, top: `calc(50% + ${offsetY(i)}px)` }}
            >
              {title}
            </span>
          ))}
          <span className="landing-orbit-core">
            <span className="landing-orbit-k">同一个词条</span>
            <span className="landing-orbit-n">{used}</span>
            <span className="landing-orbit-s">已用次数</span>
          </span>
        </div>

        <ol className="landing-jsteps">
          {STEPS.map(({ icon: Icon, no, title, lead, desc, tag, partial }, i) => (
            <li className={i === hot ? 'landing-jstep hot' : 'landing-jstep'} key={no}>
              <div className="landing-jstep-top">
                <span className="landing-jstep-icon">
                  <Icon size={17} />
                </span>
                <span className="landing-jstep-no">{no}</span>
                <h3 className="landing-feature-title">{title}</h3>
                <span className={partial ? 'landing-jtag landing-jtag-part' : 'landing-jtag'}>{tag}</span>
              </div>
              <p className="landing-jstep-lead">{lead}</p>
              <p className="landing-feature-desc">{desc}</p>
            </li>
          ))}
        </ol>
      </div>

      {/* 诚实标注：转的是**圈**，不是真时间。这一行不许被当成文案修饰删掉 */}
      <p className="landing-jnote">
        中央的数就是词条库里那个真实的「已用次数」：每完成一轮对话、正文里命中了这个词，它才加一次。
        上面 2.6 秒转一圈是把时间压缩了，其余没有虚构。
      </p>
    </section>
  );
}
