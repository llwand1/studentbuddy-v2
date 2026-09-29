#!/usr/bin/env node
/**
 * complete-v1 的**搜索快照**（`complete-v1.search.json`）生成器。
 *
 * 为什么冻结搜索：评测沙箱的出口 IP 在境外，产品的 Bing RSS 通道对它返回与查询无关的结果
 * （实测「洋务运动」返回哔哩哔哩问答），DuckDuckGo/搜狗/百度均被反爬拦截。
 * 直接在线跑会把「没搜到」与「搜到了但题不完整」混为一谈，两臂也看不到同样的输入。
 * 所以由人（本报告作者）为每个用例搜出真实的习题页，冻结成快照，评测时由 `lib/search-replay.mts`
 * 在 fetch 层回放；两臂共用、产品代码零改动；**网页正文仍然实时抓取**。
 *
 * 来源：① 参考题 `reference.sources` 里的真题页（去掉 Commons 图库页——那不是习题页）；
 *       ② 下面 EXTRA 里人工检索到的习题页（为「如图…」类题目专门找的，页面里图是 <img>）。
 * 没有习题页的用例快照为空 → 两臂的 collect 通道都拿不到页面（生成通道照常）。
 *
 * 用法：node tools/eval/datasets/complete-v1/search-fixture.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const ds = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'complete-v1.json'), 'utf8'));

const EXTRA = {
  'P01-zh-beiying': [
    ['朱自清《背影》阅读答案（精选12篇）', 'https://m.diyifanwen.com/jiaoan/yuedufudao/885275.html'],
    ['朱自清《背影》阅读答案（通用14篇）', 'https://m.diyifanwen.com/jiaoan/yuedufudao/712125.html'],
  ],
  'F01-geo-climate': [
    ['读某地气温曲线和降水量柱状图，回答23～25题 - 菁优网', 'https://www.jyeoo.com/shiti/3cff6108-115d-1553-bc56-5025e44fbc24'],
    ['下图为某地“气温变化曲线和逐月降水量”图 - 精英家教网', 'http://www.1010jiajiao.com/czdl/shiti_id_c46bf0342ec0988448a15fcd8b0d3239'],
    ['读某地气温曲线和降水柱状图，完成16～18题 - 菁优网', 'https://www.jyeoo.com/shiti/e5210200-a15c-415f-ab51-0a728f25ff17/'],
  ],
  'F02-phy-circuit': [
    ['中考物理连接简单的串并联电路专项练习 - 教习网', 'https://www.51jiaoxi.com/doc-15860996.html'],
    ['沪科版九年级全册 连接串联电路和并联电路同步训练题 - 教习网', 'https://www.51jiaoxi.com/doc-12749396.html'],
    ['如图所示的电路中，当开关S1、S2断开或闭合时 - 菁优网', 'https://www.jyeoo.com/shiti/8549d105-dd15-4915-957b-8f6d6255466e'],
  ],
  'F03-bio-foodweb': [
    ['初中生物《食物链和食物网》模拟试题 - 新浪博客', 'https://blog.sina.com.cn/s/blog_d38b4e720102zpp7.html'],
    ['生态系统的结构 - 百度题库', 'https://tiku.baidu.com/tikupc/chapterdetail/fcdac1c708a1284ac8504308-2681-10-jiaocai'],
    ['如图为某生态系统中的食物网，根据图回答有关问题 - 菁优网', 'https://www.jyeoo.com/shiti/35c106b0-6156-4159-51d0-2c33676d254d/'],
  ],
};

const out = { version: 1, engine: 'human-curated (web_search by the report author)', takenAt: new Date().toISOString().slice(0, 10), cases: {} };
for (const c of ds.cases) {
  const seen = new Set();
  const list = [];
  const push = (title, url, snippet = '') => {
    if (seen.has(url) || /commons\.wikimedia\.org/.test(url)) return;
    seen.add(url);
    list.push({ title, url, snippet });
  };
  for (const s of c.reference.sources ?? []) push(s.title, s.url);
  for (const [t, u] of EXTRA[c.id] ?? []) push(t, u);
  out.cases[c.id] = list;
}
fs.writeFileSync(path.resolve(here, '..', 'complete-v1.search.json'), JSON.stringify(out, null, 1));
const n = Object.values(out.cases).filter((l) => l.length).length;
console.log(`cases=${ds.cases.length} withPages=${n}`);
