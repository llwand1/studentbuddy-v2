/**
 * TermJourney — 落地页的「词条旅程」段（老板 2026-09-20 点单：核心功能没说白）。
 *
 * ★ 这段解决的是**叙事错位**：原先首屏讲「五环闭环」，但那是**结果**——任何聊天类产品都能
 *   这么说。真正的机制是：**词条是知识原子，五环只是它在不同阶段的形态**。故把 README
 *   「忆」三节（AI 词条库 / 艾宾浩斯复习 / 深度理解）里的机制按**用户视角的先后顺序**重排，
 *   落成五步。五步全部有代码对应，不是文案修辞：
 *     抽词 → `[TERMS]` 协议 fire-and-forget + 手动通道（README §忆·AI 词条库）
 *     高亮 → 首现实线 / 复现虚点线 + 悬浮卡（契约 TERM-HIGHLIGHT-SPEC）
 *     注入 → 加权相关性检索作第二条 system 软注入（同上）
 *     复习 → 七节点遗忘曲线 + 先还旧账 + 先翻牌（迁移 v23 / EBBINGHAUS-SPEC）
 *     沉淀 → 领域为一级实体（迁移 v19）+ 理解链（**仅部分落码**）
 *
 * ★ 诚实标注纪律：项目一律「未落地项在标题即标状态」。理解链（L0→L4）的判定未接入对话
 *   主链、无前端入口，契约头仍标「待评审」⇒ 该步的标签写「部分落地」，不写「已落地」。
 *   落地页宁可少讲一条，也不给一条会被真机打脸的话。
 */
import { ChatIcon, DocIcon, PinIcon, ClockIcon, GraphIcon } from '../components/icons';

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

export function TermJourney() {
  return (
    <section className="landing-section" aria-label="词条的完整旅程">
      <h2 className="landing-h2">
        一个词条，走完<span className="landing-accent">一整套学习流程</span>
      </h2>
      <p className="landing-section-sub">
        它不在某个单独的功能页里——从你说出它的那一刻起，抽词、标注、注入、复习由系统自动接手
      </p>
      <div className="landing-journey">
        {STEPS.map(({ icon: Icon, no, title, lead, desc, tag, partial }) => (
          <div className="landing-jstep" key={no}>
            <div className="landing-jstep-top">
              <span className="landing-jstep-icon">
                <Icon size={17} />
              </span>
              <span className="landing-jstep-no">{no}</span>
              <span className={partial ? 'landing-jtag landing-jtag-part' : 'landing-jtag'}>{tag}</span>
            </div>
            <h3 className="landing-feature-title">{title}</h3>
            <p className="landing-jstep-lead">{lead}</p>
            <p className="landing-feature-desc">{desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
