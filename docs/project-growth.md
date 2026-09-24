# 外部增长证据台账（project-growth）

> 状态：[活跃] | 建立：2026-09-24
> 定位：产品**之外**的可见性证据（GitHub 流量、站内诚实计数）统一放这里，与产品内使用指标
> `metrics-product.md` 严格分账。本文件每一行必须回答三个问题：**什么窗口、什么数据源、怎么复核**。

---

## §0 口径总则（凌驾本文件所有数字）

1. **GitHub 流量 ≠ 产品用户**。clone 计数含 CI 检出、爬虫、机器人缓存与个人 clone 重试；
   它只能作为「仓库被查看/拉取」的**辅助证据**，永远不许转写为「N 个用户」。
2. 数字必须带**观测窗口 + 采集时间**（GitHub 流量 API 只给滚动 14 天，没有历史回补，
   错过窗口就永久丢失 ⇒ 采集即留档，本文件按「快照」组织而不是按「现值」组织）。
3. 「独占（unique）」是 GitHub 自己的去重口径（按 IP+UA 粗去重），**不是按自然人去重**，引用时保留原词。

---

## §1 快照记录

### 快照 S-1 ｜ 2026-09-24 实测

**数据源**：`gh api repos/<owner>/<repo>/traffic/clones --jq .` 与 `/traffic/views`（滚动 14 天窗口），
外加仓库页面可见计数（stars / issues / releases）。复核命令：

```bash
gh api repos/llwand1/studentbuddy-v2/traffic/clones --jq '{count,uniques}'
gh api repos/llwand1/studentbuddy-v2/traffic/views  --jq '{count,uniques}'
gh api repos/llwand1/studentbuddy-v2 --jq '{stars:.stargazers_count,open_issues:.open_issues_count}'
gh api repos/llwand1/studentbuddy-v2/releases --jq 'length'
```

| 指标 | 值（14 天窗口） | 口径警示 |
|---|---|---|
| git clone 次数 | **733** | 含 CI/机器人/重复 clone，**不是用户数** |
| clone 独占数 | **230** | GitHub 按 IP+UA 去重，非自然人 |
| 页面浏览次数 | **41** | |
| 浏览独占数 | **10** | 同上 |
| stars | **3** | 采集时刻可见值 |
| 未关闭 issues | **8** | 含本人登记的待办，非他人反馈数 |
| GitHub Releases | **1**（v0.2.118） | 发版体系建立于 2026-09，之前版本无 Release 资产（不回填、不伪造历史，见 `GITHUB-OPS-SPEC.md`） |

**这组数允许的表述极限**：「开源仓库 14 天内被 clone 733 次（230 个独立来源）」——到此为止。
**禁止的表述**：任何把 733 或 230 写成「用户 / 体验人数 / 下载量代表用户」的说法。
真实用户数的唯一权威在 `metrics-product.md` §2.1（当前：6 个注册，含 owner 自己）。

---

## §2 站内诚实计数（产品侧外部可见数）

落地页「已有 N 次体验」一类宣称的唯一来源是 `GET /api/growth/counters`，
其口径、剔除规则、写侧定义全部在契约 `GROWTH-SPEC.md`（本文件不重复规定，只留指针与读数）。

| 时点 | app_open | demo_enter | register_done | 单位 | firstDay |
|---|---|---|---|---|---|
| 2026-09-24 采集 | 7 | 1 | 1 | `ip_day`（按 IP×日去重的「次」，**不是人**） | 2026-09-24 |

★ 该端点上线（v0.2.114，2026-09-23 深夜发版）后的第一个完整窗口就是上面这行——
计数体系与产品流量是同日才对齐的，此前**不存在**可用的站内「人数」数据，任何更早的对外人数宣称都无据可查。

---

## §3 已知污染源（引用 §1 数字前必读）

来自 `GROWTH-SPEC.md` §1 的实测（同一域名下的访问日志，2026-09-23 取证），以下流量**不是**潜在用户：

- UptimeRobot 探活：952 次 / 5 天；
- 伪装百度 UA 的扫描器、`ntp.msn.cn` 预取、referer 垃圾词若干；
- 本仓 `_probe/` 下三个打生产的探针脚本（作者自测流量）。

GitHub traffic 侧无对应剔除手段（API 不提供来源明细）⇒ 这是 §0 第 1 条存在的原因：
**clone 数只能永远降级为辅助证据，因为它的污染源不可枚举**。

---

## §4 更新纪律

- 每月或每次对外材料更新前，重跑 §1 复核命令并**追加新快照**（S-2、S-3…），旧快照不回改——快照序列本身就是趋势的唯一可信载体。
- 简历 / 面试叙述引用本文件数字时，必须连同 §0 的口径警示一起带出去；只带数字不带口径，视同夸大。
