/**
 * 艾宾浩斯复习计划表生成器（公开工具页，渠道 C1 的工具意图侧）。
 *
 * ★ 三条硬约束写在这层，不靠自觉：**免登录**（它不是 SPA 的一部分，应用有没有账号与它无关）、
 *   **纯前端**（日程全部在浏览器里算，见 `PLAN_PAGE_SCRIPT`）、**不落库**（整页零网络请求，
 *   这条由 `plan-tool.test.ts` 扫字节守着）。
 * ★ 关掉 JS 的访客与爬虫读到的是同一张「形状表」——它不含任何日历日期，因此永远不会过期；
 *   带日期的表只在开了脚本之后出现（★ 不在构建期烘一张带今天日期的表进字节，那是一张会烂的表）。
 */
import { REVIEW_INTERVALS_DAYS } from '@sb/shared/ebbinghaus';
import { CATALOG_PATH } from './term-corpus';
import { CHANGELOG_PATH } from './paths';
import { buildPlan } from './plan-schedule';
import { PLAN_OG_CARD, PLAN_TOOL_URL } from './og-card';
import { escapeHtml, pageFoot, pageHead, pageTop, type ShellLink } from './page-shell';

const STYLE = `
.gen { display: flex; flex-wrap: wrap; gap: .8rem 1.1rem; align-items: flex-end;
  background: #f2f5fb; border: 1px solid #e0e5f0; border-radius: 12px; padding: 1.1rem 1.1rem 1.2rem; }
.gen label { display: grid; gap: .3rem; font-size: .9rem; color: #43484f; }
.gen input { font: inherit; padding: .42rem .55rem; border: 1px solid #cfd5e0; border-radius: 8px;
  background: #fff; min-width: 7.5rem; }
.gen button, .acts button { font: inherit; font-size: .95rem; padding: .5rem .95rem; border: 0;
  border-radius: 8px; background: #2f5fd0; color: #fff; cursor: pointer; }
.acts { display: flex; gap: .6rem; margin: 1rem 0 0; }
.acts button.ghost { background: #fff; color: #2f5fd0; border: 1px solid #c3cfe8; }
table.plan { width: 100%; border-collapse: collapse; margin: 1rem 0 0; font-size: .93rem;
  font-variant-numeric: tabular-nums; }
table.plan caption { text-align: left; color: #6b7280; font-size: .88rem; padding-bottom: .5rem; }
table.plan th, table.plan td { border-bottom: 1px solid #eceef2; padding: .42rem .5rem; text-align: left; }
table.plan thead th { border-bottom: 1px solid #d7dbe3; font-weight: 600; }
table.plan td.n { text-align: right; }
table.plan tr.wk td { background: #fafbfe; }
.sum { margin: 1rem 0 0; color: #43484f; font-size: .95rem; }
@media print {
  .top, footer, .gen, .acts, .cta { display: none; }
  main { border: 0; padding: 0; margin: 0; }
  body { background: #fff; }
}
`;

const NAV: ShellLink[] = [
  { href: CATALOG_PATH, label: '全部词条' },
  { href: '/terms/yiwang-quxian.html', label: '这条规律是什么' },
];
const FOOT: ShellLink[] = [
  { href: '/', label: '回到首页' },
  { href: CATALOG_PATH, label: '全部词条' },
  { href: '/terms/yiwang-quxian.html', label: '艾宾浩斯遗忘曲线' },
  { href: '/terms/jian-ge-chongfu.html', label: '间隔重复' },
  { href: CHANGELOG_PATH, label: '更新记录' },
];

/** 形状表：不带日历日期，所以它不会过期——关脚本也看这一张 */
function shapeTable(): string[] {
  const rows = buildPlan('2026-01-01', 10, 12);
  const body = rows.map((r) => {
    const groups = r.reviewBatches.length ? r.reviewBatches.map((b) => `${b} 天前`).join('、') : '—';
    return [
      '<tr>',
      `<td>第 ${r.offset + 1} 天</td>`,
      `<td class="n">${r.newCount}</td>`,
      `<td>${escapeHtml(groups)}</td>`,
      `<td class="n">${r.reviewCount}</td>`,
      `<td class="n">${r.total}</td>`,
      '</tr>',
    ].join('');
  });
  const caption = `例：每天新学 10 条的头 12 天。这一张讲的是形状，不含日历日期；带日期的那张填上面三个格子才有。`;
  return [
    '<table class="plan">',
    `<caption>${escapeHtml(caption)}</caption>`,
    '<thead><tr><th>日子</th><th>新学</th><th>回炉几天前学的</th><th>回炉条数</th><th>当日合计</th></tr></thead>',
    '<tbody>',
    ...body,
    '</tbody>',
    '</table>',
  ];
}

/**
 * 页内脚本里**纯算法那一段**（不含任何 DOM）。
 * ★ 拆成两半是为了让测试能跑同一串字节：`plan-tool.test.ts` 把这一段 `new Function` 出来，
 *   与 `buildPlan()` 逐行对账 ⇒ 「页面算的」和「仓里锁的」漂一个节点就红，而不是靠人说一致。
 * ★ 七个复查点由构建期注入，来源是 `REVIEW_INTERVALS_DAYS`——脚本里不写死数字。
 */
export const PLAN_CORE_JS = `
  var NODES = [${REVIEW_INTERVALS_DAYS.join(',')}];
  var WD = ['日', '一', '二', '三', '四', '五', '六'];
  function pad(x) { return (x < 10 ? '0' : '') + x; }
  function key(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseKey(s) {
    var p = String(s || '').split('-');
    if (p.length !== 3) return null;
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return isNaN(d.getTime()) ? null : d;
  }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function clamp(v, lo, hi, dflt) {
    var x = Math.floor(Number(v));
    if (!isFinite(x)) x = dflt;
    return Math.min(Math.max(x, lo), hi);
  }
  function plan(startKey, dailyNew, days) {
    var rows = [], base = parseKey(startKey);
    if (!base) return rows;
    var n = clamp(dailyNew, 1, 100, 1);
    var span = clamp(days, 1, 180, 1);
    for (var off = 0; off < span; off++) {
      var d = addDays(base, off), hit = [], k;
      for (k = 0; k < NODES.length; k++) if (off - NODES[k] >= 0) hit.push(NODES[k]);
      rows.push({
        offset: off,
        date: key(d),
        weekday: WD[d.getDay()],
        newCount: n,
        reviewCount: n * hit.length,
        reviewGroups: hit,
        total: n + n * hit.length
      });
    }
    return rows;
  }
`;

/** 页内脚本里管渲染与按钮那一段（只有这一段碰 DOM） */
const PLAN_UI_JS = `
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function groupsOf(r) {
    return r.reviewGroups.length ? r.reviewGroups.join('+') + ' 天前' : '无';
  }
  function textOf(rows) {
    var out = ['复习计划表（起始 ' + rows[0].date + '，每天新学 ' + rows[0].newCount + ' 条）'];
    out.push(['日子', '日期', '星期', '新学', '回炉', '回炉的是什么', '当日合计'].join('\\t'));
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      out.push([
        '第 ' + (r.offset + 1) + ' 天', r.date, '周' + r.weekday, r.newCount, r.reviewCount,
        groupsOf(r), r.total
      ].join('\\t'));
    }
    return out.join('\\n');
  }
  function render(rows) {
    var out = document.getElementById('plan-out');
    while (out.firstChild) out.removeChild(out.firstChild);
    if (!rows.length) {
      out.appendChild(el('p', 'note', '开始日期那一格是空的或不对，先选一天。'));
      return '';
    }
    var table = el('table', 'plan');
    table.appendChild(el('caption', null, '起始 ' + rows[0].date + '（周' + rows[0].weekday +
      '）· 每天新学 ' + rows[0].newCount + ' 条 · 共 ' + rows.length + ' 天'));
    var thead = el('thead');
    var htr = el('tr');
    var heads = ['日子', '日期', '星期', '新学', '回炉', '回炉的是什么', '当日合计'];
    for (var h = 0; h < heads.length; h++) htr.appendChild(el('th', null, heads[h]));
    thead.appendChild(htr);
    var tbody = el('tbody');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var tr = el('tr', r.weekday === '六' || r.weekday === '日' ? 'wk' : '');
      tr.appendChild(el('td', null, '第 ' + (r.offset + 1) + ' 天'));
      tr.appendChild(el('td', null, r.date));
      tr.appendChild(el('td', null, '周' + r.weekday));
      tr.appendChild(el('td', 'n', r.newCount));
      tr.appendChild(el('td', 'n', r.reviewCount));
      tr.appendChild(el('td', null, groupsOf(r)));
      tr.appendChild(el('td', 'n', r.total));
      tbody.appendChild(tr);
    }
    var n = 0, rv = 0, peak = rows[0];
    for (var j = 0; j < rows.length; j++) {
      n += rows[j].newCount; rv += rows[j].reviewCount;
      if (rows[j].total > peak.total) peak = rows[j];
    }
    table.appendChild(thead);
    table.appendChild(tbody);
    out.appendChild(table);
    out.appendChild(el('p', 'sum', '合计：新学 ' + n + ' 条、回炉 ' + rv + ' 条。单日最多的一天是第 ' +
      (peak.offset + 1) + ' 天，' + peak.total + ' 条——回炉量本来就是阶梯式涨上来的，做不完就把每天新学量调小。'));
    return textOf(rows);
  }
  var current = '';
  function run() {
    // ★ 钳制在 plan() 里面做，与 buildPlan() 同一个位置——两边钳的位置不一样，就对不出同一张表
    current = render(plan(
      document.getElementById('f-start').value,
      Number(document.getElementById('f-daily').value),
      Number(document.getElementById('f-days').value)
    ));
  }
  function copied() {
    var b = document.getElementById('b-copy');
    b.textContent = '已复制';
    setTimeout(function () { b.textContent = '复制文字版'; }, 1600);
  }
  function copy() {
    if (!current) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(current).then(copied, function () {});
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = current;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); copied(); } catch (e) {}
    document.body.removeChild(ta);
  }
  document.getElementById('f-start').value = key(new Date());
  document.getElementById('b-go').addEventListener('click', run);
  document.getElementById('b-print').addEventListener('click', function () { window.print(); });
  document.getElementById('b-copy').addEventListener('click', copy);
  run();
`;

/**
 * 页内那一段完整的脚本。★ 输出全部走 DOM API（不用 `innerHTML`）：既避开注入面，
 *   也避免字符串里出现闭合标签那种会当场终结 `<script>` 的写法。
 */
export const PLAN_PAGE_SCRIPT = `(function () {\n${PLAN_CORE_JS}\n${PLAN_UI_JS}\n})();`;

const SECTIONS: readonly { h: string; p: readonly string[] }[] = [
  {
    h: '这张表是怎么排出来的',
    p: [
      '一条内容学完之后，在第 1、2、4、7、15、30、60 天各回炉一次。这七个点是本产品复习队列用的同一组节点，也是把艾宾浩斯那条曲线投影到「天」这个刻度上的结果。',
      '于是排期不需要每天发明新东西：今天学的这一组，往后在这七个日子各自回来一次；昨天、前天学的，各自沿着同一条线往前走。同一天要见的是「几天前学的那几组」，不是一个笼统的「复习」。',
    ],
  },
  {
    h: '为什么表越往后越重',
    p: [
      '每天的新学量是平的，可要见的旧组数在涨：第 5 天有三组要见，第 16 天有五组，第 61 天七组全到。单日条数因此阶梯式上升，这是这套安排本身的形状，不是有人在给你加量。',
      '拿这个数去定每天新学几条，比凭感觉定靠谱：如果第三十天的合计明显超出一天能做完的量，就把新学量调小，或者把总天数拉长。宁可慢，也不要排一张第三天就想放弃的表。',
    ],
  },
  {
    h: '三条容易做歪的地方',
    p: [
      '第一，把表当打卡。表管的是「什么时候再见一面」，不管「这一面有没有真的想起来」——照着日子把书翻一遍，练到的还是认得出，不是想得起。',
      '第二，落后就整组跳过。漏掉的那几组不会自己补回来，正确动作是把开始日期改成今天重新排一次，而不是在后面追加欠账。',
      `第三，把七个点当圣旨。哪一面明显想不起来，就把那一组的下一次提早；一眼就想起的，可以推到下一个点。判断依据是当时的吃力感，不是表上写死了 ${REVIEW_INTERVALS_DAYS.join('、')}。`,
    ],
  },
];

/** 生成工具页的完整 HTML */
export function renderPlanToolPage(): string {
  const head = pageHead({
    title: '艾宾浩斯复习计划表在线生成 - StudentBuddy',
    desc: `填开始日期与每天新学几条，按 ${REVIEW_INTERVALS_DAYS.join('/')} 天七个复查点排出一张逐日任务表。免登录，不存数据。`,
    canonical: PLAN_TOOL_URL,
    card: PLAN_OG_CARD,
    extraStyle: STYLE,
  });
  const body: string[] = [...pageTop(NAV)];
  body.push('<h1>复习计划表生成器</h1>');
  body.push(`<p class="alias">按 ${REVIEW_INTERVALS_DAYS.join(' / ')} 天这七个复查点排</p>`);
  body.push(
    '<p class="lead">填三个格子：什么时候开始、每天新学几条、想排多少天。表当场在你浏览器里算出来，' +
      '不登录、不上传，换台设备也不会记得你填过什么。</p>',
  );
  body.push('<section class="gen">');
  body.push('<label>开始日期<input type="date" id="f-start"></label>');
  body.push('<label>每天新学（条）<input type="number" id="f-daily" value="10" min="1" max="100" step="1"></label>');
  body.push('<label>排多少天<input type="number" id="f-days" value="60" min="1" max="180" step="1"></label>');
  body.push('<button type="button" id="b-go">重新排一次</button>');
  body.push('</section>');
  body.push(
    '<div id="plan-out">' +
      '<p class="note">填上面三个格子，你自己那张带日期的表出现在这里。</p>' +
      '<noscript><p class="note">这台设备关着脚本，所以出不来带日期的那张。下面那张不带日期的例子和生成器用的是同一套安排，照着它手排也一样能用。</p></noscript>' +
      '</div>',
  );
  body.push(...shapeTable());
  body.push(
    '<p class="acts"><button type="button" id="b-print">打印这张表</button>' +
      '<button type="button" id="b-copy" class="ghost">复制文字版</button></p>',
  );
  for (const sec of SECTIONS) {
    body.push(`<h2>${escapeHtml(sec.h)}</h2>`);
    sec.p.forEach((para) => body.push(`<p>${escapeHtml(para)}</p>`));
  }
  body.push('<aside class="cta">');
  body.push('<h2>不想自己管这张表的时候</h2>');
  body.push(
    '<p>本产品的复习队列干的就是这张表的活：每个词条学过一次之后，它自己按这七个点决定下一次什么时候出现，' +
      '答不上来就退回短间隔。省掉的是「同时盯几十组各自的进度」这件事。</p>',
  );
  body.push('<a href="/">看看怎么用</a>');
  body.push('</aside>');
  body.push(...pageFoot(FOOT));
  body.splice(body.length - 2, 0, `<script>${PLAN_PAGE_SCRIPT}</script>`);

  return [...head, ...body].join('\n');
}
