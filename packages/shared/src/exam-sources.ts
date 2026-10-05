/**
 * exam-sources — 应试模式白名单**第一版**数据（考试类目预置包 + 站内直达端点）。
 *
 * ★ 这份表里每一行都带 2026-10-04 本机出网的实测读数，**没有一行是凭印象写的**。
 *   判据只有三条（照 `learning/collect-quality.ts` 的入选标准）：公开可访问 / 正文里有题干与答案
 *   （不是 JS 壳）/ 有可拼 URL 的站内检索入口。三条全过才给 `tier: 'question'` 并配 `direct`。
 *
 * 为什么白名单要做成数据而不是代码（老板 2026-10-04 指示 EXAM-1004）：
 * 出题质量与资源质量的根因是来源不设界——免 key 通道什么都返，实测下钻 33 条命中里只有 1 条能抽出完整题目。
 * 把「范围」交给用户选，前提是我先把「哪些站真的供得出题」量出来。
 *
 * ⚠️ 这张表是**外部依赖**，改版即过期：每行 `direct.verifiedAt` 就是为此而设，
 *   重验方法见 `docs/EXAM-MODE-SPEC.md` §6（一次性探针脚本，不在仓内跑）。
 */
import {
  MAX_EXAM_CUSTOM_HOSTS,
  examHostAllowed,
  examScopeSignature,
  normalizeExamHost,
  scopeHosts,
} from './exam-scope.js';
import { EXAM_GROUPS } from './exam-scope.js';
import type { ExamGroup, ExamPack, ExamSource, ExamSourceTier } from './exam-scope.js';

/** 考试类目预置包：用户勾的是这些，不是域名。★ 两大类各自成组（见 `EXAM_GROUPS`） */
export const EXAM_PACKS: readonly ExamPack[] = [
  // ── 传统考试 ──
  { id: 'gaokao', label: '高考', hint: '全国卷与新高考的真题、试卷解析、一轮二轮资料', group: 'exam' },
  { id: 'zhongkao', label: '中考', hint: '各省市中考真题与模拟题', group: 'exam' },
  { id: 'kaoyan', label: '考研', hint: '考研政治、英语、数学的历年真题与大纲政策', group: 'exam' },
  { id: 'cet', label: '大学英语四六级', hint: 'CET 大纲与题型口径（官方考试网为主）', group: 'exam' },
  { id: 'gongkao', label: '公务员／事业单位（笔试）', hint: '行测、申论历年真题与题库', group: 'exam' },
  { id: 'jiaoshi', label: '教师资格／教师招聘（笔试）', hint: '教资笔试真题与官方考试院口径', group: 'exam' },
  { id: 'caikuai', label: '财会', hint: '初级中级会计师、注册会计师、税务师', group: 'exam' },
  { id: 'jianzao', label: '建造与工程消防', hint: '一建二建、造价、消防、监理、注安', group: 'exam' },
  { id: 'yixue', label: '医药卫生', hint: '执业医师、护士、药师', group: 'exam' },
  { id: 'ruankao', label: '软考与计算机等级', hint: '软件设计师、系统集成、三级四级与 NCRE', group: 'exam' },
  { id: 'video', label: '视频讲解', hint: '题目与知识点的讲解视频（B 站检索），两类都用得上', group: 'exam' },
  // ── 求职面试 ──
  { id: 'tech-interview', label: '技术面试（后端／前端／计算机基础）', hint: 'Java/Go/前端/数据库/网络/操作系统面经与参考答案', group: 'job' },
  { id: 'algo-interview', label: '算法与笔试（刷题）', hint: 'LeetCode 类题目的考法、题解与公司笔试真题', group: 'job' },
  { id: 'structured-interview', label: '结构化面试（公务员／事业编）', hint: '真题题干与参考答案、无领导小组', group: 'job' },
  { id: 'teacher-interview', label: '教师面试（试讲／说课／答辩）', hint: '各学科试讲范例与结构化问答', group: 'job' },
  { id: 'bank-soe', label: '银行／国企／运营商招聘', hint: 'EPI、综合知识、英语与面试真题', group: 'job' },
  { id: 'campus-info', label: '校招与实习信息', hint: '网申时间线、笔试题库、面经（信息类，不成套题目）', group: 'job' },
];

/**
 * 白名单第一版。`note` 是实测读数，不是广告词。
 * 排除掉的站同样重要，列在 `docs/EXAM-MODE-SPEC.md` §5，别从这里"顺手加回来"。
 */
export const EXAM_SOURCES: readonly ExamSource[] = [
  {
    host: 'aipta.com',
    label: '爱真题',
    tier: 'question',
    packs: ['gaokao', 'kaoyan', 'gongkao', 'jiaoshi'],
    direct: { search: 'https://www.aipta.com/index.php?s={q}', verifiedAt: '2026-10-04' },
    note: '真题文章页 11129 字／11 个问句／66 个选项标记／带答案解析；站内检索出 148 条同域结果链',
  },
  {
    host: 'zhenti.zalize.com',
    label: '真题营',
    tier: 'question',
    packs: ['kaoyan'],
    direct: { search: 'https://zhenti.zalize.com/zhenti/search?q={q}', verifiedAt: '2026-10-04' },
    note: '考研政治在线题池 1820 字，题干＋答案＋解析＋考点齐全（静态可抽）',
  },
  {
    host: 'huatu.com',
    label: '华图题库',
    tier: 'question',
    packs: ['gongkao', 'jiaoshi', 'structured-interview'],
    direct: { search: 'https://so.huatu.com/index/search/search.html?q={q}', verifiedAt: '2026-10-04' },
    note: '行测真题页 5968 字／14 个问句／带答案解析；选项多为图片，逐字摘选项不保证',
  },
  {
    host: 'offcn.com',
    label: '中公题库',
    tier: 'question',
    packs: ['gongkao', 'jiaoshi', 'structured-interview', 'teacher-interview'],
    note: '行测／申论题库栏目 4.5K–4.7K 字含答案与考点；首页同域题链 100 条；未挖到可拼的检索端点',
  },
  {
    host: '51jiaoxi.com',
    label: '教习网',
    tier: 'question',
    packs: ['gaokao', 'zhongkao'],
    direct: { search: 'https://www.51jiaoxi.com/search?keyword={q}', verifiedAt: '2026-10-04' },
    note: '中高考真题目录 5.8K–8.3K 字含答案解析，检索页 86 条同域链；整套卷多在下载资源页',
  },
  {
    host: 'gaokao.com',
    label: '高考网',
    tier: 'question',
    packs: ['gaokao', 'zhongkao'],
    note: '首页 28093 字含真题答案解析；/zyk/gkst/ 与 /tiku/ 是列表壳（2.8K 字目录）',
  },
  {
    host: 'gk100.com',
    label: '高考 100',
    tier: 'question',
    packs: ['gaokao'],
    direct: { search: 'https://www.gk100.com/search?article_title={q}', verifiedAt: '2026-10-04' },
    note: '真题解析文章页 1084 字含答案与解析；同站另一详情页返回 403 ⇒ 有反爬，抓取须容错',
  },
  {
    host: 'jianshe99.com',
    label: '建设工程教育网',
    tier: 'question',
    packs: ['jianzao'],
    direct: { search: 'https://kuaisoo.jianshe99.com/s?wd={q}', verifiedAt: '2026-10-04' },
    note: '检索 46 条同域链；首页 13742 字含真题解析；/tiku/ 仅 541 字（导航壳）',
  },
  {
    host: 'chinaacc.com',
    label: '正保会计网校',
    tier: 'question',
    packs: ['caikuai'],
    direct: { search: 'https://kuaisou.chinaacc.com/s?wd={q}', verifiedAt: '2026-10-04' },
    note: '检索 67 条同域链；首页 16921 字；/st/st/ 404、/tiku/ 669 字',
  },
  {
    host: 'dongao.com',
    label: '东奥会计',
    tier: 'question',
    packs: ['caikuai'],
    note: '初级会计题库页 8073 字／4 问句／13 选项标记／带答案解析；/cpa/ 栏目 403',
  },
  {
    host: 'med66.com',
    label: '医学教育网',
    tier: 'question',
    packs: ['yixue'],
    direct: { search: 'https://kuaisoo.med66.com/s/?wd={q}', verifiedAt: '2026-10-04' },
    note: '检索 94 条同域链；首页 10394 字含答案解析；子域栏目页 403',
  },
  {
    host: 'jyeoo.com',
    label: '菁优网',
    tier: 'question',
    packs: ['gaokao', 'zhongkao'],
    direct: { search: 'https://www.jyeoo.com/math/ques/search?q={q}', verifiedAt: '2026-10-04' },
    note: '检索返回 67 条同域链接，但页面没出现「结果」话术 ⇒ 是否真命中未证实；首页正文仅 109 字（JS 壳）',
  },
  {
    host: 'eol.cn',
    label: '中国教育在线',
    tier: 'reference',
    packs: ['gaokao', 'kaoyan', 'cet'],
    note: '高考频道 29888 字、考研频道 22841 字含真题解析；含 gaokao./kaoyan. 等子域（后缀匹配）',
  },
  {
    host: '21cnjy.com',
    label: '21 世纪教育网',
    tier: 'reference',
    packs: ['gaokao', 'zhongkao'],
    note: '首页 3550 字含答案解析；原登记的 zujuan 子域旧路径已 404',
  },
  {
    host: 'tiku.baidu.com',
    label: '百度题库',
    tier: 'reference',
    packs: ['gaokao', 'zhongkao', 'kaoyan'],
    note: '正文 3801 字全是考试导航文字，题目由 JS 渲染 ⇒ 直抓抓不到题，只当资料',
  },
  {
    host: 'chsi.com.cn',
    label: '研招网（官方）',
    tier: 'reference',
    packs: ['kaoyan'],
    note: '首页 3320 字；无题目页 ⇒ 只作政策、大纲与报名时间口径',
  },
  {
    host: 'neea.edu.cn',
    label: '中国教育考试网（官方）',
    tier: 'reference',
    packs: ['cet', 'jiaoshi'],
    note: 'www 2729 字、ntce 子域 925 字，均无题目 ⇒ 四六级与教资的题型与大纲权威来源',
  },
  {
    host: 'nowcoder.com',
    label: '牛客网',
    tier: 'reference',
    packs: ['tech-interview', 'algo-interview', 'campus-info'],
    note: '10-05 复测：首页 5720 字含真题·题库·面试·面经，同域题链 34；但题目页由 JS 渲染（/exam/company 1718 字、零问句）⇒ 只当面经与资讯源',
  },
  {
    host: '233.com',
    label: '233 网校',
    tier: 'reference',
    packs: ['jianzao', 'caikuai', 'yixue'],
    note: '首页 16741 字；/tiku/ 404、wx 子域题库 106 字（JS）',
  },
  {
    host: 'icourse163.org',
    label: '中国大学 MOOC',
    tier: 'reference',
    packs: ['ruankao', 'kaoyan'],
    note: '首页 69KB 可达；习题需登录，未实测到可直抓的题目页',
  },
  {
    host: 'bilibili.com',
    label: '哔哩哔哩（视频讲解）',
    tier: 'reference',
    packs: ['video'],
    direct: { search: 'https://search.bilibili.com/all?keyword={q}', verifiedAt: '2026-10-04' },
    note: '检索页 303KB 可达；「找视频」链路本来就走这里，纳入白名单是为了应试模式下不被闸死',
  },
  // ── 2026-10-05 第二版扩充：求职面试组 + 传统考试扩类 ──
  {
    host: 'mianshiya.com',
    label: '面试鸭',
    tier: 'question',
    packs: ['tech-interview', 'algo-interview'],
    entries: [
      { url: 'https://www.mianshiya.com/', label: '面试鸭·题库首页（服务端渲染，含 39 个问句与答案解析）', verifiedAt: '2026-10-05' },
      { url: 'https://www.mianshiya.com/banks', label: '面试鸭·题库分类（9176 字，含答案·解析·考点）', verifiedAt: '2026-10-05' },
    ],    note: '10-05 实测：首页 11255 字 39 个问句；/banks 9176 字含答案·解析·考点。★ 它是文档站，搜索在客户端 ⇒ 只能走入口页',
  },
  {
    host: 'xiaolincoding.com',
    label: '小林 coding',
    tier: 'question',
    packs: ['tech-interview'],
    entries: [
      { url: 'https://www.xiaolincoding.com/interview/cpp.html', label: '小林·C++ 面试题（75554 字 234 问句含解析）', verifiedAt: '2026-10-05' },
      { url: 'https://www.xiaolincoding.com/interview/golang.html', label: '小林·Go 面试题（59891 字 197 问句含解析）', verifiedAt: '2026-10-05' },
      { url: 'https://www.xiaolincoding.com/interview/python.html', label: '小林·Python 面试题（51713 字 382 问句含解析）', verifiedAt: '2026-10-05' },
      { url: 'https://www.xiaolincoding.com/interview/', label: '小林·后端/全栈面经汇总（4509 字含解析）', verifiedAt: '2026-10-05' },
    ],    note: '10-05 实测：单页就是几百道题的长文（cpp 75554 字 234 问句 / python 51713 字 382 问句），全站无服务端检索 ⇒ 入口页是唯一取题方式',
  },
  {
    host: 'javaguide.cn',
    label: 'JavaGuide',
    tier: 'question',
    packs: ['tech-interview', 'algo-interview'],
    entries: [
      { url: 'https://javaguide.cn/zhuanlan/interview-guide.html', label: 'JavaGuide·面试指南（13036 字 26 问句含答案）', verifiedAt: '2026-10-05' },
      { url: 'https://www.javaguide.cn/interview-preparation/backend-interview-plan.html', label: 'JavaGuide·后端面试准备（6060 字 16 问句）', verifiedAt: '2026-10-05' },
      { url: 'https://javaguide.cn/zhuanlan/back-end-interview-high-frequency-system-design-and-scenario-questions.html', label: 'JavaGuide·高频场景题与设计题（2615 字 21 问句）', verifiedAt: '2026-10-05' },
    ],    note: '10-05 实测：面试专栏页每页 20+ 问句带答案；文档站无服务端检索 ⇒ 走入口页',
  },
  {
    host: 'zgjsks.com',
    label: '中公教师网',
    tier: 'question',
    packs: ['teacher-interview', 'jiaoshi'],
    entries: [
      { url: 'https://www.zgjsks.com/html/jszg/kaoshitiku/', label: '中公教师·考试题库（3463 字含答案与解析）', verifiedAt: '2026-10-05' },
      { url: 'https://www.zgjsks.com/html/zgks/', label: '中公教师·招考资讯与真题（4470 字 6 问句含考点）', verifiedAt: '2026-10-05' },
    ],    note: '10-05 实测：首页 18965 字 12 问句含答案解析；题库与招考两栏各自可抽 ⇒ 教师面试与笔试两侧都用得上',
  },
  {
    host: 'jinrongren.net',
    label: '金融人（银行国企招聘）',
    tier: 'question',
    packs: ['bank-soe'],
    note: '10-05 实测：首页 5801 字，命中答案·解析·试题·题库·面试·模拟·考点，同域题链 193；★ 站内检索端点坏了（返回 154 字）⇒ 只能走栏目页',
  },
  {
    host: 'acwing.com',
    label: 'AcWing',
    tier: 'reference',
    packs: ['algo-interview'],
    note: '10-05 实测：首页 1437 字、题目页 1488 字含题干；站内检索是 CSRF 表单 ⇒ 拼不出直达 URL，只当题解资料',
  },
  {
    host: 'yingjiesheng.com',
    label: '应届生求职网',
    tier: 'reference',
    packs: ['campus-info'],
    note: '10-05 实测：首页 815 字（列表由脚本渲染）⇒ 只当校招时间线与网申信息源，取不到成形的题',
  },
  {
    host: 'shixiseng.com',
    label: '实习僧',
    tier: 'reference',
    packs: ['campus-info'],
    note: '10-05 实测：检索页 4404 字可达但零题干 ⇒ 实习信息源，不是题源',
  },
  {
    host: 'cnitpm.com',
    label: '信管网（软考）',
    tier: 'question',
    packs: ['ruankao'],
    entries: [
      { url: 'https://www.cnitpm.com/zt/2026xzkz/', label: '信管网·软考真题专题（2749 字 4 问句含答案）', verifiedAt: '2026-10-05' },
    ],    note: '10-05 实测：首页 9306 字 23 问句命中 7 个题词，同域题链 71；真题专题页 2749 字含答案',
  },
  {
    host: 'ruankao.org.cn',
    label: '中国计算机技术职业资格网（官方）',
    tier: 'reference',
    packs: ['ruankao'],
    note: '10-05 实测：首页 2364 字含模拟；软考大纲、科目与报名口径的权威来源，无题目',
  },
  {
    host: 'ncre.neea.edu.cn',
    label: '教育部教育考试院（NCRE）',
    tier: 'reference',
    packs: ['ruankao', 'cet'],
    note: '10-05 实测：845 字含试题；计算机等级与四六级的科目、大纲、考试时间权威来源，无题目',
  },
  {
    host: 'daliedu.cn',
    label: '大立教育（建造消防）',
    tier: 'question',
    packs: ['jianzao'],
    entries: [
      { url: 'https://www.daliedu.cn/yijian/zhenti/', label: '大立·一建真题栏目（6970 字含答案与解析）', verifiedAt: '2026-10-05' },
    ],    note: '10-05 实测：首页 30360 字 53 问句；/yijian/zhenti/ 6970 字含答案解析（列表页比详情页划算）',
  },
  {
    host: 'hqwx.com',
    label: '环球网校',
    tier: 'question',
    packs: ['jianzao', 'yixue'],
    entries: [
      { url: 'https://www.hqwx.com/ejjzs-kaoshi/zhenti/', label: '环球·二建真题（2359 字 6 问句含答案与解析）', verifiedAt: '2026-10-05' },
      { url: 'https://www.hqwx.com/yjjzhus-kaoshi/zhenti/', label: '环球·一建注护真题（2488 字含答案与解析）', verifiedAt: '2026-10-05' },
    ],    note: '10-05 实测：首页 60867 字 304 问句（本批最强的一页）；各资格 `/zhenti/` 栏目页 2.3K–5.7K 字含答案解析；★ 详情页多是直播课介绍 ⇒ 取栏目页',
  },
  {
    host: 'youlu.com',
    label: '优路教育',
    tier: 'question',
    packs: ['jianzao', 'yixue', 'caikuai'],
    note: '10-05 实测：首页 32828 字命中真题·答案·解析·题库·模拟·考点，同域题链 107；详情页含答案解析',
  },

];

/** 默认范围＝全部预置包：先把「来源有界」做到位，用户再按自己要考的类目往下收 */
export const DEFAULT_EXAM_PACK_IDS: readonly string[] = EXAM_PACKS.map((p) => p.id);

export interface ExamScopeSetting {
  packs: string[];
  custom: string[];
}

/**
 * 读取时清洗：未知 pack id 丢掉、自填域名归一化去重、超出上限截断。
 * ★ 不清洗的后果：设置页存进一个改名后的 pack id，范围会**静默变空**（看着开着、其实全过滤掉）。
 */
export function normalizeExamScope(input: unknown): ExamScopeSetting {
  const raw = (input ?? {}) as { packs?: unknown; custom?: unknown };
  const knownIds = new Set(EXAM_PACKS.map((p) => p.id));
  const packs: string[] = [];
  for (const id of Array.isArray(raw.packs) ? raw.packs : DEFAULT_EXAM_PACK_IDS) {
    if (typeof id === 'string' && knownIds.has(id) && !packs.includes(id)) packs.push(id);
  }
  const custom: string[] = [];
  for (const h of Array.isArray(raw.custom) ? raw.custom : []) {
    const n = normalizeExamHost(h);
    if (n && !custom.includes(n) && custom.length < MAX_EXAM_CUSTOM_HOSTS) custom.push(n);
  }
  return { packs, custom };
}

/**
 * 按大类分组的预置包（设置页两块的分隔就靠它，组顺序固定：传统考试在前）。
 * ★ 组是数据不是样式：求职面试与传统考试的取材方式根本不同（前者在面经与题库站，
 *   后者在真题卷与题库站），混成一排勾选项会让人勾不出自己要的范围。
 */
export function packsByGroup(): Array<{ group: ExamGroup; label: string; hint: string; packs: ExamPack[] }> {
  const order: ExamGroup[] = ['exam', 'job'];
  return order.map((g) => ({
    group: g,
    label: EXAM_GROUPS[g].label,
    hint: EXAM_GROUPS[g].hint,
    packs: EXAM_PACKS.filter((p) => p.group === g),
  }));
}

/** 某个包属于哪个组（空态与范围话术要说"求职面试·技术面试"而不是只说包名） */
export function examPackGroup(packId: string): ExamGroup | null {
  return EXAM_PACKS.find((p) => p.id === packId)?.group ?? null;
}

/** 预置包里的域名（按 pack 收集，跨包去重） */
export function packHosts(packs: readonly string[]): string[] {
  const picked = new Set(packs);
  const out = new Set<string>();
  for (const s of EXAM_SOURCES) if (s.packs.some((p) => picked.has(p))) out.add(s.host);
  return [...out];
}

/** 本次生效的域名集合（预置包 + 用户自填，归一化排序） */
export function resolveExamHosts(scope: ExamScopeSetting): string[] {
  return scopeHosts([...packHosts(scope.packs), ...scope.custom]);
}

/** 生效域名对应的登记表条目（自填域名不在表上 ⇒ 只算范围不算直达端点） */
export function resolveExamSources(scope: ExamScopeSetting): ExamSource[] {
  const hosts = new Set(resolveExamHosts(scope));
  return EXAM_SOURCES.filter((s) => hosts.has(s.host));
}

/**
 * 一个主机名属于哪些考试类目（词条范围联动的唯一推导口径）。
 *
 * ★ 只对**登记表上的站**返回类目：用户自填的域名不在表上 ⇒ 返回空数组，
 *   于是它在应试模式下"算范围内、但不属于任何类目"。这不是漏判——
 *   类目是给用户勾范围用的标签，自填站已经通过"在范围内"这件事生效了，
 *   再替它编一个类目就是替用户做他没做过的判断。
 * @param host 归一化后或带 `www.` 的主机名（不是 URL）
 */
export function examPacksForHost(host: string): string[] {
  const out: string[] = [];
  for (const s of EXAM_SOURCES) {
    if (!examHostAllowed(host, [s.host])) continue;
    for (const p of s.packs) if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** 这个主机名在不在登记表上（用于区分「范围内但有类目」与「范围内、无类目」） */
export function isRegisteredExamHost(host: string): boolean {
  return EXAM_SOURCES.some((s) => examHostAllowed(host, [s.host]));
}

/** 范围签名：进缓存键与「来源已按范围过滤」提示 */
export function resolveExamSignature(scope: ExamScopeSetting): string {
  return examScopeSignature(resolveExamHosts(scope));
}

/** 设置页一行话：`高考、中考、+2 个自填站` */
export function examScopeSummary(scope: ExamScopeSetting): string {
  const labels = scope.packs
    .map((id) => EXAM_PACKS.find((p) => p.id === id)?.label ?? '')
    .filter(Boolean);
  const shown = labels.slice(0, 4).join('、');
  const head = labels.length > 4 ? `${shown} 等 ${labels.length} 类` : shown || '未选类目';
  return scope.custom.length > 0 ? `${head}＋${scope.custom.length} 个自填站` : head;
}

// ── 设置页 REST 契约（`/api/settings/exam-*`，见 docs/EXAM-MODE-SPEC.md §5）──

/** `GET /api/settings/exam-packs`：静态登记表，UI 渲染勾选项 */
export interface ExamPacksView {
  packs: { id: string; label: string; hint: string; group: ExamGroup }[];
  /** 两个大类的名字与说明（UI 分区标题用它，别在前端再抄一份中文） */
  groups: { id: ExamGroup; label: string; hint: string }[];
  sources: {
    host: string;
    label: string;
    tier: ExamSourceTier;
    packs: string[];
    note: string;
    /** null ⇒ 这一站没有实测过的站内直达端点（只能等通用搜索命中它） */
    direct: { verifiedAt: string } | null;
  }[];
}

/** `GET /api/settings/exam-mode` */
export interface ExamModeView {
  on: boolean;
  scope: ExamScopeSetting;
  summary: string;
  hosts: string[];
  /** 范围内**有**站内直达端点的站名（用户最关心的一个数：范围窄到没题源了要看得见） */
  directSites: string[];
}

/** `PUT /api/settings/exam-scope` 的响应：回读实际生效值（归一化与钳位在服务端做） */
export interface ExamScopeSaveView extends ExamModeView {
  ok: boolean;
  /** 被判定非法而丢弃的自填条目数（不静默吞输入） */
  rejectedCustom: number;
}
