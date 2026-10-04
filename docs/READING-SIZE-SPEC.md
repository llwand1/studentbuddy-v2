# READING-SIZE-SPEC — 阅读区字号

> 代码：`web/src/lib/reading-prefs.ts`（档位表 / 读写 / 落 DOM，唯一事实源）、
> `web/src/styles/reading.css`（缩放规则）、`web/src/features/settings/ReadingSizeCard.tsx`（设置卡）。
> 测试：`lib/reading-prefs.test.ts`（状态）、`styles/reading.css.test.ts`（样式结构锁）。
> 版本：v0.2.157 起。

## 1. 要解决的问题

正文 14px 在高分屏笔记本上偏小，长时间读对话与词条释义费眼。但这套界面是**像素风**：
导航、卡牌墙、知识大陆的地块都按固定网格排，整体放大会把版面撑破（地块错位、卡墙换行、
督促胶囊压住正文）。

所以口径是：**只放大要逐字读的那两处**——对话正文与词条释义，其余一律不动。

## 2. 档位

| id | 标签 | 缩放比 | 正文 |
| --- | --- | --- | --- |
| `s` | 小 | 0.93 | 13px |
| `m` | 标准（**出厂值**） | 1 | 14px |
| `l` | 大 | 1.14 | 16px |
| `xl` | 特大 | 1.29 | 18px |

`m` 的缩放比恒为 1 ⇒ **老用户升级后一个像素都不变**。

只有四档、不给自由输入：自由输入会让人调出 9px 或 40px 这种把版面搞坏的值，
而这四档都是按像素网格试过的比例。

## 3. 怎么落

状态是**本机**的（`localStorage: sb:reading:size`），不进服务端设置：字号是**这块屏幕**的事
（27 寸台式机与 13 寸笔记本要的不一样），跨设备同步它反而是打扰；而且它必须在首帧之前生效，
多等一个 GET 会「先小后大」闪一下。同 `drill-prefs.ts` 的口径，读写全 try/catch，
隐私模式 / 配额满时静默退回默认值。

DOM 上只有一个事实源：`<html data-reading="s|m|l|xl">`，由 `applyReadingSize` 写，
`main.tsx` 在 `createRoot` 之前调 `initReadingSize()` 落上。

缩放不是逐条写 `font-size`，而是在阅读区容器上**重新定义 `--sb-fs-*` 这组 token**：

```css
.chat-bubble, .term-def {
  --sb-fs-md: calc(14px * var(--sb-reading-scale));
  /* xs / sm / lg / xl 同理 */
  font-size: var(--sb-fs-md);
}
```

`markdown.css` 本来就全走 token（h1/h2/代码/表格/脚注…），于是整棵 markdown 树按同一比例
变大，**版面层级关系不走样**；以后在阅读区里新增的元素只要继续用 token，自动跟着缩放，
不用再回来改这里。

`.term-def` 在 `terms.css` 里写死过 `13px`（没走 token），`reading.css` 用同等特异性覆盖它 ⇒
**`reading.css` 必须排在功能样式之后**（`main.tsx` 里它在 `mobile.css` 之前、其余样式之后），
结构锁第 ④ 条钉的就是这个顺序。

## 4. 不做什么

- **不做整站缩放**：理由见 §1。想要整站放大的人用浏览器自带的 Ctrl +，那是系统级能力，不该重造。
- **不做服务端同步**：理由见 §3。
- **不覆盖手机端 12px 下限**：`mobile.css` 的 `--sb-fs-xs: 12px` 仍然生效（它在最后引入），
  小号档不会把手机端的辅助文字压到更小。

## 5. 已知边界

- jsdom 没有布局引擎 ⇒ **量不出「字真的变大了」**。测试分两层：状态层测「存了什么、读回什么、
  落到哪个属性」，样式层用结构锁测「规则还在、且在能生效的位置」。真实缩放效果靠人眼验收。
  这是一条**登记在案的欠账**，不是「已覆盖」。
- 设置卡里的预览用的是真实的 `.chat-bubble` 类名 ⇒ 预览与对话走同一条规则，不存在
  「预览好看、实际两样」。
