/**
 * shared/reader-doc —— 阅读页的**块模型**与选区上下文（契约 `docs/SOURCE-TRACE-SPEC.md` §14）。
 *
 * 为什么要有块模型：原来的阅读页是一段清洗过的 HTML 字符串，塞进 `sandbox` iframe 里显示。
 * iframe 不给 `allow-same-origin` ⇒ **主文档读不到里面的选区**，划线功能无从谈起。
 * 2026-10-04 起阅读页改为「服务端出结构、前端用 React 渲染进主文档」：
 *   - 选区天然可读（`window.getSelection()` 就在同一个文档里）；
 *   - 前端**不用 `dangerouslySetInnerHTML`**——块模型只有受控字段，渲染成 React 元素，
 *     第三方 HTML 不再以字符串形态进入 DOM，比"清洗后再 innerHTML"少一整类风险；
 *   - 块带稳定 `id` ⇒ 选区能锚到具体段落，于是能反查"这段在哪一节里"（§14.3）。
 *
 * ★ 这里只有**数据形状与纯函数**，零 IO、零 DOM：服务端用它产出、前端用它渲染与算上下文，
 *   两端共读同一份定义，不会出现"服务端以为是 h2、前端当成 p"。
 */

/** 行内片段：链接是唯一带副作用的那种，所以它单独成型，其余只是样式 */
export type ReaderInline =
  | { t: 'text'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'em'; v: string }
  | { t: 'code'; v: string }
  /** `href` 一定是绝对 http(s)（服务端清洗时已绝对化并剔除 `javascript:`） */
  | { t: 'link'; v: string; href: string };

/** 块：每块一个稳定 `id`（`b{序号}`），选区锚点与章节反查都靠它 */
export type ReaderBlock =
  | { t: 'h'; id: string; level: 1 | 2 | 3 | 4 | 5 | 6; spans: ReaderInline[] }
  | { t: 'p'; id: string; spans: ReaderInline[] }
  | { t: 'li'; id: string; ordered: boolean; depth: number; spans: ReaderInline[] }
  | { t: 'quote'; id: string; spans: ReaderInline[] }
  | { t: 'pre'; id: string; v: string }
  | { t: 'img'; id: string; src: string; alt: string }
  | { t: 'hr'; id: string };

/** `GET /api/sources/read` 的成功响应（§14.1） */
export interface ReaderPage {
  ok: true;
  url: string;
  title: string;
  site: string;
  /** 作者 / 时间，来自 meta；没有就空串 */
  byline: string;
  blocks: ReaderBlock[];
  /** 正文太短（多半是脚本渲染页）⇒ 前端给「看原网页 / 截图」的出口 */
  thin: boolean;
}

export interface ReaderPageFail {
  ok: false;
  url: string;
  status: number;
  reason: string;
}

export type ReaderPageResult = ReaderPage | ReaderPageFail;

/** 划线后送进模型的那份材料（§14.3）；三个动作（讲解 / 出题 / 存词条）共用同一个形状 */
export interface ReaderSelection {
  /** 用户划中的原文，已折叠空白、已截断 */
  text: string;
  /** 所在章节的标题（最近一个在它之前的标题）；没有标题层级就空串 */
  heading: string;
  /** 所在章节的正文（含划线那段），给模型当上下文——不是整页，见 §14.3 的预算 */
  section: string;
  /** 这页的出处，进提示词时原样引用，让模型知道材料来自哪 */
  sourceTitle: string;
  sourceUrl: string;
}

/** 选区本身的上限：再长就不是"划一句"而是"抄一段"，送进去也只是挤占上下文 */
export const READER_SELECTION_MAX = 1_000;
/** 章节上下文的上限（§14.3：选区 + 所在章节，不是整页） */
export const READER_SECTION_MAX = 2_500;

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** 截断到 `max` 字，断在边界上并加省略号——半截词比少一句更难读 */
export function clipText(s: string, max: number): string {
  const t = squash(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('.'));
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** 一块的纯文本（图片取 alt，分隔线为空） */
export function blockText(b: ReaderBlock): string {
  if (b.t === 'pre') return b.v;
  if (b.t === 'img') return b.alt;
  if (b.t === 'hr') return '';
  return b.spans.map((s) => s.v).join('');
}

/** 整页纯文本（给"存为资料"与兜底用） */
export function readerPlainText(blocks: readonly ReaderBlock[]): string {
  return blocks
    .map(blockText)
    .filter((s) => s.trim() !== '')
    .join('\n');
}

/**
 * 找某一块所在的「章节」：从它往前找最近的标题，再从该标题往后收，
 * 直到遇到**同级或更高级**的标题为止（h2 的章节在下一个 h2 或 h1 处结束，h3 不打断它）。
 *
 * 没有任何标题的页面（很多博客正文就是一串 p）⇒ 退回「这一块前后各若干块」的邻域，
 * 总之不能返回空：模型拿不到上下文就会把代词、简称、公式片段讲偏（这正是选 §14.3 这档的理由）。
 */
export function sectionForBlock(blocks: readonly ReaderBlock[], blockId: string): { heading: string; text: string } {
  const at = blocks.findIndex((b) => b.id === blockId);
  if (at < 0) return { heading: '', text: '' };

  let headAt = -1;
  for (let i = at; i >= 0; i -= 1) {
    const b = blocks[i];
    if (b && b.t === 'h') {
      headAt = i;
      break;
    }
  }

  if (headAt < 0) {
    // 无标题页：取前后邻域（前 3 块、后 6 块），够模型判断语境又不至于整页
    const from = Math.max(0, at - 3);
    const to = Math.min(blocks.length, at + 7);
    return { heading: '', text: blocks.slice(from, to).map(blockText).filter(Boolean).join('\n') };
  }

  const head = blocks[headAt] as Extract<ReaderBlock, { t: 'h' }>;
  let end = blocks.length;
  for (let i = headAt + 1; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (b && b.t === 'h' && b.level <= head.level) {
      end = i;
      break;
    }
  }
  return { heading: blockText(head), text: blocks.slice(headAt, end).map(blockText).filter(Boolean).join('\n') };
}

export interface SelectionInput {
  blocks: readonly ReaderBlock[];
  /** 选区覆盖到的块 id（按文档序）；取第一块来定章节 */
  blockIds: readonly string[];
  /** 用户划中的原文 */
  selected: string;
  sourceTitle: string;
  sourceUrl: string;
}

/**
 * 组装送进模型的那份材料。**章节里一定包含划线那段**（它本来就在章节内），
 * 所以模型既看得见这句话、也看得见它在讲什么。
 *
 * ★ 截断发生在这里而不是各个动作里：三个动作（讲解 / 出题 / 存词条）共用同一份预算，
 *   否则"讲解送 2500 字、出题送整页"这种偏差会悄悄长出来。
 */
export function buildReaderSelection({ blocks, blockIds, selected, sourceTitle, sourceUrl }: SelectionInput): ReaderSelection {
  const text = clipText(selected, READER_SELECTION_MAX);
  const first = blockIds[0] ?? '';
  const sec = first ? sectionForBlock(blocks, first) : { heading: '', text: '' };
  return {
    text,
    heading: squash(sec.heading),
    section: clipText(sec.text, READER_SECTION_MAX),
    sourceTitle: squash(sourceTitle),
    sourceUrl,
  };
}

/** 选区是否值得动作：太短（点一下选中一个标点）就别让三个按钮亮起来 */
export const READER_SELECTION_MIN = 2;

export function isUsableSelection(s: string): boolean {
  return squash(s).length >= READER_SELECTION_MIN;
}
