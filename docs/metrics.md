# studentbuddy v2 · 量化基线

> **本文件的数字不许手抄。** 标记区之内由 `node tools/metrics.mjs --write-docs` 生成，
> 手改会在下一次回填时被覆盖；要改口径就改脚本，不要改这里。
>
> 为什么要有这条规矩：本文件的前身（2026-09-06 手工采集，基准 `47a4845`）在 14 天内就整体失真
> ——它写「31 文件 / 382 用例 / 13,629 行源码 / 48 个端点」，而同期实际已长到三位数文件、两千例。
> 同时 `README.md` 把测试基线抄成了两组互相矛盾的数字（157/2166 与 160/2212 并存）。
> **手抄的数字一定会腐烂，所以改成一条命令产出。** 旧版内容按 §作废登记 处理，不做静默删除。

## 复现命令

```bash
node tools/metrics.mjs                    # 静态计数（秒级）
node tools/metrics.mjs --tests --coverage # 连 vitest 全量与覆盖率一起采（本机约 36s）
node tools/metrics.mjs --write-docs       # 回填本文件标记区 + 写 docs/metrics.json
node tools/metrics.mjs --check            # README/首屏手抄数字与实测对账，有漂移退出码 1
                                          # ★ 只读：不写 docs/metrics.json
```

机器产物：`docs/metrics.json`（同一批数字的 JSON 形态，供脚本/CI 消费）。
★ 只有**不带 `--check`** 的运行会刷新它 —— `--check` 是纯检查，不改工作区。

<!-- metrics:begin —— 以下由 tools/metrics.mjs --write-docs 回填，勿手改 -->

> 采集：2026-09-24 22:21:20（本机时区）｜ 基准 `1269c9f` ｜ 复现：`node tools/metrics.mjs --tests --coverage`

## 工程规模（源码 / 测试行数，按包）

| 包 | 源码文件 | 源码行 | 测试文件 | 测试行 | 测试/源码 |
|---|---|---|---|---|---|
| shared | 30 | 4,482 | 18 | 2,251 | 50% |
| server | 168 | 26,832 | 120 | 26,047 | 97% |
| web | 202 | 26,384 | 73 | 10,749 | 41% |
| **合计** | **400** | **57,698** | **211** | **39,047** | **68%** |

## 接口与契约

- REST 路由注册：**151**（get 66 / post 54 / delete 15 / put 15 / patch 1）· 另 /api 挂载点 27 个
- shared 契约类型：**150**（export interface 97 + export type 53）
- 外部运行时依赖：**6** 个 —— better-sqlite3, cors, express, pino, react, react-dom
- 迁移水位：代码侧 **v42**（42 个 version 条目，非连续号 0 处）

## 测试基线（vitest 实跑）

- **211 文件 / 2922 例**（2921 passed + 1 skipped + 0 failed）⇒ 全绿
- 本次本机实跑（Node v22.23.2）全量耗时 28.2s
- jsdom 交互测试文件（`.test.tsx`）23 个

## 覆盖率（v8，按包加权 covered/total，非百分比平均）

| 范围 | Lines | Branches | Stmts | Funcs |
|---|---|---|---|---|
| shared | 99.3% | 91.2% | 99.3% | 100% |
| server | 88.9% | 83% | 88.9% | 93.1% |
| web | 43.9% | 83.7% | 43.9% | 60.2% |
| **三包合计** | 67.7% | 83.8% | 67.7% | 78.7% |
- ⚠️ 口径：分母只含 vitest 实际 import 到的源文件（未跑到 0% 的模块不进 json-summary 的按包聚合），故本表**只能用于同版本自身纵向对比**，不能与外部项目横比。
- ⚠️ 覆盖率产物是 4 天前的（本次未跑 `--coverage`）

## 文档与仓库
- docs/：SPEC 契约 30 份 · md 共 43 份（dev/ 5）· 真机探针 15 个
- git：main @ `1269c9f`（2026-09-24）· 近 14 天 189 commits · 工作区未提交 28 文件

<!-- metrics:end -->

## 线上运行态快照（手工采集，采集时点写死在每段）

> 这一节不进 `metrics.mjs`：它测的是**那台机器**，不是这个仓库。复现命令逐条附在下面。
> 采集：2026-09-20 13:55 CST，`root@<服务器IP>`（RackNerd 1GB VPS），全程只读。

### 主机资源

| 项 | 实测值 | 复现命令 |
|---|---|---|
| 内存 | total 961MB / used 403MB / buff-cache 640MB / **available 557MB** | `free -m` |
| Swap | 1024MB，仅用 35MB | `swapon --show` |
| 磁盘 | 19GB，用 6.3GB，余 12GB（36%） | `df -h /` |
| uptime / load | 127 天 / 0.15 0.04 0.01 | `uptime` |
| **内核 OOM kill 次数** | **0** | `dmesg -T \| grep -i oom-kill`；`journalctl -k \| grep -ic oom` |

★ `DEPLOY.md` §3 原有叙述「内存吃满被 OOM kill ⇒ 偶发 502 几秒后自愈」**在本机无证据支撑**（OOM 计数为 0，uptime 127 天）。
502 类中断确实发生过（见下方 watchdog 记录），★ 且**那一次的成因已由 `journalctl` 定为 systemd 主动重启、与内存无关** ⇒ 该因果链在本机**已被证伪**，`DEPLOY.md` 同批订正完毕。

### 应用进程内存（现状：跑源码 + tsx）

| 进程 | RSS | 定性 |
|---|---|---|
| `node --require tsx/preflight.cjs …` | 90 MB | 承载业务的那个 |
| `npm exec tsx src/index.ts` | 63 MB | 包装层开销 |
| `node .bin/tsx src/index.ts` | 43 MB | 包装层开销 |
| `esbuild --service` | 24 MB | tsx 的即时转译子进程 |
| **合计** | **≈ 220 MB** | 其中 **≈130MB 是「跑源码」的税** |

`systemctl show studentbuddy -p MemoryCurrent` = 138MB（仅主进程），`MemoryMax` = 419430400（400MB）。
⇒ 编译态切换（`node dist/index.js`）的预期收益即这 130MB；施工计划尚未成文（`DEPLOY.md` §3 第 1 条只登记了「现状跑源码」这一事实）。

复现：`ps -eo pid,ppid,rss,comm,args --sort=-rss | head`

### 服务可用性（watchdog 留痕）

`/opt/studentbuddy/watchdog.log`（每 5 分钟一次采样，**只在状态翻转时落笔**）：

```
2026-09-20 00:06:12 DOWN resp=none
2026-09-20 00:06:16 DOWN resp=none
2026-09-20 00:06:33 RECOVERED
```

⇒ 已观测到的不可用：1 次事件、持续约 21 秒、连续 2 个采样周期。
★ **该次 DOWN 已定因，与内存无关**（2026-09-20 补测）：`journalctl -u studentbuddy` 显示
`00:06:11 Stopping studentbuddy.service` → `00:06:12 Deactivated successfully` → `00:06:12 Started` → `00:06:17 listening`
—— 是 systemd 主动重启（发版/人工）。当日该 unit 启停类事件共 **12** 次，均为成对的 `Stopping → Started`。
复现：`journalctl -u studentbuddy --since today | grep -E 'Stopping|Deactivated|Started|listening'`
⚠️ **口径缺陷（已知，未修）**：`sb-watchdog` 仅 9 行，健康时不落任何记录 ⇒ **没有分母**，
因此**算不出可用性百分比**，也记不到延迟/内存/CPU。要能算可用性，必须改成「每次采样都落一行」。
★ **而「没有分母」正是那条错误归因能存活至今的原因**：watchdog.log 里一条 `DOWN` 看不出是重启还是故障，
只能靠 `journalctl` 反查 ⇒ 光留痕不够，**要留全样本**。这是量化侧第一件要改造的事。

### 线上库与真实使用量（决定性的一节）

`sqlite3 "file:/opt/studentbuddy/data/studentbuddy.db?mode=ro"`（只读打开）：

| 表 | 行数 | 含义 |
|---|---|---|
| `users` | 1 | 只有项目所有者自己的账号 |
| `sessions` | 1 | 一次会话 |
| `messages` | 1 | `role=user`、正文长度 2、时间 2026-09-19 14:42 ⇒ **上线当天的冒烟测试** |
| assistant 消息 | 0 | **线上从未完成过一次对话** |
| `event_log` | 0 | 可观测事件（契约齐备：`latency_ms` / `tokens_in` / `tokens_out`） |
| `daily_activity` | 0 | XP / 每日计数原料 |
| `tool_stats` / `quiz_stats` / `user_stats` | 0 | 同上 |
| `user_memory` | 0 | 跨会话画像 |
| 表总数 / schema 水位 | 41 张 / **v36** | 库健康；`PRAGMA integrity_check` 未在本轮跑 |
| 备份 | `sb-2026-09-20.db` 524K，`backup ok` | `/var/log/sb-backup.log` |

★ **`sqlite_sequence` 里上述统计表连条目都不存在** ⇒ 不是「插入过又被清除」，而是**从未成功写入过一行**。
结合 assistant=0，结论是：**零流量，而非采集链路故障**。

⚠️ 但由此暴露一个真问题：**空库与"没人用"在系统内不可区分**，遥测链路自身没有心跳。
任何后续看板必须先解决这条，否则「指标为 0」永远是一个无法解释的值。

⇒ **推论（重要）**：产品行为类指标（留存 / 功能分布 / 转化）当前 n=0，**不得出任何百分比报表**；
物理量类指标（内存 / 延迟 / 可用性 / 上游成本）不受 n 限制，但需要先有真实或合成流量。

### 运行环境落差（待收口）

| 项 | 线上 | 仓库要求 | 状态 |
|---|---|---|---|
| Node | v20.20.2 | `engines: >=22.11.0` + `.nvmrc` | ❌ **违约运行**（能跑，但不受保证） |
| schema 水位 | v36 | 代码侧 v37 | ⚠️ 落后一次迁移，下次重启才会应用 |
| 部署形态 | ssh 直传 + systemd，跑源码 | —— | 容器化/编译态均未做 |
| Docker | **已装**（docker-ce 29.8.1 + compose 5.5.1） | —— | ❌ `docker.service` failed：`/etc/docker/daemon.json` 内是一行非 JSON 文本（写入于 2026-06-23 12:40，三个月后首次重启才引爆）；`/var/lib/docker` 424K ⇒ 从未真正跑过容器 |

## 作废登记

| 作废项 | 原值（2026-09-06，基准 `47a4845`） | 作废原因 | 替代 |
|---|---|---|---|
| 工程规模表 | 源码 13,629 行 / 测试 4,305 行 / 106 文件 | 14 天内失真，且无产出器 | 本文件标记区（命令可重跑） |
| 测试基线 | 31 文件 / 382 例 | 同上 | 同上 |
| 「REST API 端点 48」 | 48 | 口径未定义（与路由注册数差近 3 倍），且原文件自认「源码 grep ±2 偏差」 | 标记区给出明确口径：`<x>Router.(get\|post\|put\|delete\|patch)(` 计数 |
| 覆盖率分模块表 | 51.4% statements 等 | 手工抄录，无复现命令 | 标记区 v8 加权表 + 口径限制说明 |
| 「内存吃满致偶发 502」因果 | —— | OOM kill 计数为 0，无证据；★ 且唯一那次 DOWN 已由 `journalctl` 定为 systemd 主动重启 | 归因**证伪**并从 `DEPLOY.md` §3 撤下；可用性改由 watchdog 全样本落笔后重算（见 §服务可用性） |

★ 以上各项的**结论层面**已同步到 `DEPLOY.md` 与 `README.md` 的引用处；历史沿革不在此回改。
