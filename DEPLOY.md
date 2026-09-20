# 部署手册 — studentbuddy v2 线上形态

> 这份文档回答一个问题：**线上那台机器是怎么跑的，怎么发版，出事了怎么回。**
>
> 它是 [`README.md`](README.md) §部署形态 与 [`docs/dev/launch-plan.md`](docs/dev/launch-plan.md) §3 的**执行面**——那两处讲「为什么要有这些闸门」，这里讲「实际怎么配、怎么验、怎么退」。
>
> 线上状态：**<https://11wand.com>** 自 2026-09-19 起运行（`2.0.0-alpha.0`）。
>
> ⚠️ **本仓是公开仓库**：本文**不含任何密钥、口令、私钥或哈希**；服务器地址已在 `tools/deploy.sh` 中公开，如介意请改为读环境变量。

---

## 1. 拓扑

```
用户浏览器
   │  HTTPS（Caddy 自动申请 / 续期 Let's Encrypt 证书）
   ▼
Caddy（11wand.com :443）
   ├─ /api/*      → reverse_proxy 127.0.0.1:18791   ← studentbuddy API（systemd 守护）
   ├─ /stats*     → reverse_proxy 127.0.0.1:8090    ← GoatCounter（自托管，无 cookie 统计）
   ├─ /reports/*  → basicauth + 静态 /opt/studentbuddy/reports   ← goaccess 访问报告
   └─ 其余         → 静态 /opt/studentbuddy/app/packages/web/dist（SPA，try_files 回退 index.html）

studentbuddy.service（systemd, root）
   └─ npx tsx src/index.ts          ← 注意：跑的是**源码**，不是编译产物
        └─ SQLite /opt/studentbuddy/data/studentbuddy.db（WAL）
```

---

## 2. 服务器清单

| 项 | 值 |
|---|---|
| 主机 | RackNerd VPS —— `SERVER` 见 `tools/deploy.sh`（默认 `root@107.172.96.209`） |
| 规格 | 1 vCPU / 961 MB RAM / 19 GB 磁盘 / 1 GB swap（实测 2026-09-20） |
| SSH | `ssh -i ~/.ssh/id_ed25519 root@<SERVER>`（密钥路径可用 `KEY` 覆盖） |
| 应用目录 | `/opt/studentbuddy/app` —— **ssh 直传，不是 git 仓库**（服务器上没有 `.git`） |
| 数据目录 | `/opt/studentbuddy/data`（对应 `SB_DATA_DIR`） |
| 备份目录 | `/opt/studentbuddy/backup` —— 独立 git 仓，推私有远端 |
| 统计 | `/opt/studentbuddy/analytics`（GoatCounter sqlite） |
| 报告 | `/opt/studentbuddy/reports`（goaccess 生成的 HTML） |
| env 文件 | `/opt/studentbuddy/app/.env`（权限 600 root） |

---

## 3. 应用进程

`/etc/systemd/system/studentbuddy.service`：

```ini
[Unit]
Description=StudentBuddy v2 API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/studentbuddy/app/packages/server
EnvironmentFile=/opt/studentbuddy/app/.env
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=always
RestartSec=3
MemoryMax=400M

[Install]
WantedBy=multi-user.target
```

★ **三条容易踩的**：

1. **跑源码、不跑 dist**：`ExecStart` 是 `tsx src/index.ts` ⇒ 发版必须把 `packages/server/src` 传上去；服务器上**没有** `packages/server/dist`，只传编译产物是白传。
2. **`MemoryMax=400M` 是 1 GB 机器上的硬上限**（超了会 cgroup OOM kill，再由 `Restart=always` 拉起）。
   ★ **而「偶发 502 ＝ 内存吃满」这句归因此前是推断，2026-09-20 实测被证伪**：开机 **127 天**、内核 oom-kill 计数 **0 次**、`MemoryCurrent` 实测 **138MB**（离 400MB 上限很远）。
   中断**确实发生过**——`/opt/studentbuddy/watchdog.log`：`00:06:12 DOWN`、`00:06:16 DOWN`、`00:06:33 RECOVERED`（连续 2 个采样周期、约 21 秒）。★ 当日 `journalctl -u studentbuddy` 给出了定因：`00:06:11 systemd Stopping studentbuddy.service` → `00:06:12 Deactivated successfully` → `00:06:12 Started` → `00:06:17 listening` —— **这是人为/发版重启，与内存无关**（当天该 unit 共 12 次启停类事件，均为成对的 `Stopping → Started`）。
   ⇒ **不要据此去调小全站并发闸门**。剩下的真缺口是 §7 那条「健康时不落笔」：没有分母就永远算不出可用性，也就永远无法区分「重启的正常停机」与「事故」。逐条判据与复现命令见 [`docs/metrics.md`](docs/metrics.md) §线上运行态快照。
3. **改 `.env` 后必须 `systemctl restart`**，不是 `reload`（`EnvironmentFile` 只在进程启动时读一次）。

常用操作：

```bash
systemctl status studentbuddy          # 看状态
systemctl restart studentbuddy         # 重启（发版后）
journalctl -u studentbuddy -n 100 -f   # 跟日志
```

---

## 4. 反向代理

`/etc/caddy/Caddyfile`：

```caddyfile
11wand.com {
	encode gzip
	root * /opt/studentbuddy/app/packages/web/dist
	log {
		output file /var/log/caddy/access.log {
			roll_size 10mb
			roll_keep 5
		}
	}
	handle /api/* {
		reverse_proxy 127.0.0.1:18791
	}
	handle /stats* {
		reverse_proxy 127.0.0.1:8090
	}
	redir /reports /reports/ 301
	handle_path /reports/* {
		basicauth bcrypt {
			boss <哈希在服务器上，不入仓>
		}
		root * /opt/studentbuddy/reports
		file_server
	}
	handle {
		try_files {path} /index.html
		file_server
	}
}
```

要点：

- **TLS 全自动**：Caddy 自己申请与续期证书，不需要 certbot、不需要手工续期任务。
- **`handle` 的顺序有意义**：`/api/*`、`/stats*`、`/reports/*` 必须排在兜底 `handle` 之前，否则全被 SPA 回退吃掉。
- **SPA 路由**靠 `try_files {path} /index.html`（`#/pk` 这类前端路由刷新不会 404）。
- **`/reports/*` 走 basicauth**：访问报告里有真实 UA / 路径，不公开。
- ★ **`SB_TRUST_PROXY=1` 与 Caddy 下发 `X-Forwarded-For` 是同一件事的两处**：Caddy 默认会加 XFF，但 Express 侧必须开 `trust proxy` 才会去读。漏配的症状是 `req.ip` 恒为反代地址 ⇒ **全站共用一个 IP 桶**，发码限流退化成全站上限（详见 README §部署形态 的表）。

改完 Caddy 配置：`caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`。

---

## 5. 环境变量

全部在 `/opt/studentbuddy/app/.env`（**改完重启服务**）：

| 变量 | 线上值 | 不配 / 配错的症状 |
|---|---|---|
| `SB_PORT` | `18791` | 与 Caddy 的 `reverse_proxy` 目标不一致 ⇒ 全站 502 |
| `SB_HOST` | `0.0.0.0` | 缺省 `127.0.0.1` 只绑回环 ⇒ 反代连不上（本机开发无感，上线即挂） |
| `SB_DATA_DIR` | `/opt/studentbuddy/data` | 指向非持久卷 ⇒ 每次发版数据归零 |
| `SB_REQUIRE_AUTH` | `1` | 不强制鉴权 ⇒ **任何人可读写全站数据**（多用户形态必须开） |
| `SB_COOKIE_SECURE` | `1` | HTTPS 站点下发非 Secure cookie ⇒ 会话可被明文链路截获 |
| `SB_TRUST_PROXY` | `1` | 见 §4 末条：IP 限流退化成全站一个桶 |
| `SB_ALLOWED_ORIGINS` | `https://11wand.com` | 部署域名不在白名单 ⇒ 带真实域名的**所有 POST 一律 403，全站瘫痪**；⚠️ **不收通配符**，配错宁可显式失败 |
| `SB_UPSTREAM_SITE_MAX_CONCURRENT` | `8`（**占位值**） | 全站免费通道并发封顶；沿用占位值，用户会收到「当前免费通道繁忙」 |
| `SB_UPSTREAM_SITE_QUEUE_MAX` | `20` | 队列满时**明确拒绝**而非无限排队 |
| `RESEND_API_KEY` + `SB_MAIL_FROM` | 已配 | ★ **两个都配齐才真发信**；只配一个会静默走控制台兜底，症状是「点了发送、界面说成功、邮箱永远没有」 |
| `SB_GITHUB_CLIENT_ID` + `SB_GITHUB_CLIENT_SECRET` | 见 §9 | 两个都配齐入口才画（`/api/auth/providers` 探针决定）；callback 必须与 GitHub OAuth App 登记的完全一致 |

---

## 6. 备份与恢复

`/etc/cron.d/studentbuddy-ops`：

```cron
0 3 * * *   root  /usr/local/bin/sb-backup
*/5 * * * * root  /usr/local/bin/sb-watchdog
```

`/usr/local/bin/sb-backup`（每日 03:00）做四件事：

1. `sqlite3 .backup` 出 `/opt/studentbuddy/backup/sb-<日期>.db`（**用 `.backup` 而不是 `cp`** —— WAL 模式下直接拷主库会拿到不一致快照）
2. `PRAGMA integrity_check` 校验，**不是 `ok` 就退出非 0**（坏备份当场暴露，而不是等真要恢复时才发现）
3. `git commit` 后 push 到私有仓 `llwand1/studentbuddy-backup`（**异地**：机器整个挂掉也能取回）
4. 本地删掉 7 天前的档（滚动窗口）

### 恢复步骤

```bash
SERVER=root@107.172.96.209   # 与 tools/deploy.sh 一致

# 1) 停服务（避免恢复期间还在写）
ssh -i ~/.ssh/id_ed25519 $SERVER 'systemctl stop studentbuddy'

# 2) 取回备份（备份仓里每天一个档）
ssh -i ~/.ssh/id_ed25519 $SERVER 'cd /opt/studentbuddy/backup && git pull --ff-only'

# 3) 换库 —— ★ 必须连 -wal / -shm 一起处理
ssh -i ~/.ssh/id_ed25519 $SERVER 'cd /opt/studentbuddy/data && \
  mv studentbuddy.db studentbuddy.db.broken-$(date +%s) && \
  rm -f studentbuddy.db-wal studentbuddy.db-shm && \
  cp /opt/studentbuddy/backup/sb-2026-09-20.db studentbuddy.db'

# 4) 起服务并验活
ssh -i ~/.ssh/id_ed25519 $SERVER 'systemctl start studentbuddy && sleep 3 && \
  curl -sf http://127.0.0.1:18791/api/health'
curl -sf https://11wand.com/api/health
```

★★ **第 3 步的 `rm -f *.db-wal *.db-shm` 不是可选项**：WAL 里存着主库之后的所有写入，只换主库、留着旧 WAL，SQLite 会把**旧 WAL 重放到新库上** —— 回滚等于没做，而且数据处于半新半旧的混合态，比不回滚更难查。

---

## 7. 可观测

| 手段 | 位置 | 说明 |
|---|---|---|
| **健康自检** | `/usr/local/bin/sb-watchdog`（每 5 分钟） | `curl /api/health`；异常往 `/opt/studentbuddy/watchdog.log` 写 `DOWN`，恢复写 `RECOVERED`。**只在出事时落笔 ⇒ 健康的那 5 分钟不留痕，日志里没有分母，算不出可用性百分比，只能给出 DOWN 次数**（改造方向见下）。**只留痕不告警**——对外告警由外部监控（UptimeRobot）承担，理由：机器自己挂了就发不出告警 |
| **访问统计** | GoatCounter（systemd，`127.0.0.1:8090`，`-base-path /stats`） | 无 cookie、不落 IP，前端埋 `/stats/count.js` |
| **访问报告** | `/usr/local/bin/sb-goaccess-report`（每日 04:10） | 解析 Caddy JSON 日志（含轮转档）→ goaccess → `/opt/studentbuddy/reports/index.html`（**`--anonymize-ip`**），经 `/reports/` 带 basicauth 访问 |
| **应用日志** | `journalctl -u studentbuddy` | pino 输出 |
| **反代日志** | `/var/log/caddy/access.log`（10 MB × 5 滚动） | |

看门狗日志出现 `DOWN` 不代表事故——发版重启也会留一条（正常模式是 `DOWN` 紧接 `RECOVERED`，间隔几十秒）。**持续多行 `DOWN` 才是事故**。

★ **判 `DOWN` 之前先查 `journalctl -u studentbuddy`**：2026-09-20 那条 21 秒的 `DOWN` 就是这样定因的——同一分钟有 `Stopping studentbuddy.service`，说明是人为/发版重启而非故障。**光看 watchdog.log 分不出这两者，而它正是「内存吃满导致 502」这个错误归因存活至今的原因。**

★ **量化侧第一件要改造的就是这条**：让 watchdog **每次采样都落一行**（时刻 + 状态 + 该次 `curl` 耗时 + `MemoryCurrent`），有了全样本分母才能出可用性与延迟分布，也才能在下次 `DOWN` 出现时立刻排除或坐实内存假设。改造前先不改判。

---

## 8. 发版流程

仓内 `tools/deploy.sh`（**在本机跑，不在服务器跑**）：

```bash
SERVER=${SERVER:-root@107.172.96.209}
KEY=${KEY:-$HOME/.ssh/id_ed25519}
APP=/opt/studentbuddy/app

npm run check     # 门禁：tsc×3 + eslint + vitest + gates（任一步红即停，set -e）
npm run build     # web dist + server 产物
tar -C packages/web -cf - dist | ssh -i "$KEY" "$SERVER" "tar -xf - -C $APP/packages/web/"
rsync -a --exclude node_modules --exclude .git --exclude dist --exclude .zcode ./ "$SERVER:$APP/"
ssh -i "$KEY" "$SERVER" "systemctl restart studentbuddy && sleep 5 && curl -sf http://127.0.0.1:18791/api/health"
```

★ **门禁在发版脚本第一步，不是摆设**：`set -e` 意味着 `npm run check` 红 ⇒ **一个字节都不会上传**。这是「线上永远不会跑一个类型检查不过的版本」的唯一保证。

★ **本机没有 `rsync` 时**（Windows Git Bash 常见）最后两步手工替代：

```bash
# 只传真正需要的三份：server 源码 + shared 源码 + web 构建产物
tar -cf - packages/server/src packages/shared/src | ssh -i "$KEY" "$SERVER" "tar -xf - -C $APP/"
tar -C packages/web -cf - dist | ssh -i "$KEY" "$SERVER" "tar -xf - -C $APP/packages/web/"
ssh -i "$KEY" "$SERVER" "systemctl restart studentbuddy && sleep 5 && curl -sf http://127.0.0.1:18791/api/health"
```

发版后**必做**的三步验证：

```bash
curl -sf https://11wand.com/api/health                  # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' https://11wand.com/api/auth/providers
ssh -i ~/.ssh/id_ed25519 $SERVER 'journalctl -u studentbuddy -n 30 --no-pager'   # 看有没有迁移报错
```

**迁移是自动的**：服务启动时按 `schema_version` 逐版本升级（`storage/migrations.ts`）。跨版本发版前**先确认备份跑过**（`/var/log/sb-backup.log` 里当天有 `backup ok`），因为 ADD COLUMN 型迁移失败会把服务钉在起不来的状态。

---

## 9. 首次配置 / 换机清单

换服务器或首次部署时，除 §5 的 env 外还要：

1. **Caddy**：装好后按 §4 写 Caddyfile，`caddy validate` 再 `systemctl reload caddy`（证书由 Caddy 自动申请，**域名 A 记录必须先指对**，否则申请失败）
2. **systemd**：按 §3 落 unit，`systemctl daemon-reload && systemctl enable --now studentbuddy`
3. **依赖**：`cd $APP && npm ci`（`better-sqlite3` 是原生模块，**装依赖的 Node 大版本必须与运行的一致**）
4. **cron**：按 §6 落 `/etc/cron.d/studentbuddy-ops`
5. **运维脚本**：`/usr/local/bin/{sb-backup,sb-watchdog,sb-goaccess-report}` 三个脚本 + `chmod +x`
6. **GoatCounter**：独立 systemd 服务，`goatcounter serve -db sqlite+/opt/studentbuddy/analytics/goatcounter.sqlite -listen 127.0.0.1:8090 -base-path /stats`
7. **发信 DNS**：`SB_MAIL_FROM` 所在域配 **SPF / DKIM / DMARC**；Resend 侧验证域名
8. **GitHub OAuth App**：callback 填 `https://<域名>/api/auth/github/callback`，把 client id / secret 写进 `.env`
9. **备份仓**：在备份目录 `git init` 并指向私有远端，且**配好免密 push 的 deploy key**（`sb-backup` 里 push 失败不会中断服务，但会静默丢异地备份 —— 要定期看 `/var/log/sb-backup.log`）

---

## 10. 回滚

**代码回滚**（发版后发现新版本有问题）：

```bash
cd /path/to/studentbuddy-v2
git checkout <上一个已知good的提交>
bash tools/deploy.sh          # 重新发一次
git checkout main             # 发完切回来
```

★ **不要用 `git stash` 做临时对照**（本仓有过一次事故：`stash` 被中断后仓库进入撕裂状态）。要对照旧版本用 `git show <ref>:<path>`（只读）或 `git worktree add`（独立目录）。

**数据回滚**：见 §6 的恢复步骤。

★ **迁移是单向的**：`ALTER TABLE ADD COLUMN` 之后，旧代码读到新库通常没问题（多余列被忽略），但**新代码读过新库之后再回滚代码，不保证兼容**（比如新代码写了旧 schema 没有的列）。所以「先发版再回滚」这条路要连同数据一起考虑，稳妥做法是**回滚代码的同时用备份把库也退回去**。

---

## 11. 已知运维边界

- **单实例**：`SB_UPSTREAM_SITE_MAX_CONCURRENT` 是**进程内 Map**，多实例部署下容量 × 实例数，全站封顶只在单进程内成立。
- **全站并发值 8 是占位值**，未按真实业务校准。
- **看门狗只留痕、不告警**（对外告警依赖外部监控服务）。
- **备份是「每日一次」**：最坏情况会丢一天的数据。要更小的 RPO 得加 WAL 归档或提高备份频率。
- **`/opt/studentbuddy/app` 不是 git 仓库**：服务器上的代码状态**无法用 `git log` 追溯**，只能靠本机提交历史 + 发版时间对应。想知道线上跑的是哪个版本，看 `/api/status`（若暴露版本号）或比对文件 mtime。
- **本手册的配置快照取自 2026-09-20 实测**；服务器上的配置文件是**真相源**，本文与服务器不一致时以服务器为准，并回来更新本文。
