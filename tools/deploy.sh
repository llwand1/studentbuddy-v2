#!/usr/bin/env bash
# deploy.sh — 一键发布（本机 Git Bash 执行）。
#
# 流程：check → build → 建回滚点 → 打包上传 → 解包 app-new → 带 .env → 复用 node_modules
#       → 预演（库副本，不碰生产库）→ mv 切换 → 重启 → 健康检查 → sha256 验证。
#
# ★★ 2026-09-21 重写（原版从未跑通过一次）
#   原版第 4 步写 `rsync -a ...`，而**本机与服务器两端都没有 rsync**（`which rsync` 皆空）
#   ⇒ 这个「一键发布」从落地起就是纸面产物；线上历来是手工 `tar | ssh` 推上去的
#   （旁证：线上文件属主是 uid 197609 ＝ Windows SID，不是服务器上的 root）。
#   现在改成与手工流程同源的 `tar | ssh`，并把三处**漏一步就出事**的地方补进流程：
#     ① 回滚点（库 `.backup` 快照 + 旧代码整目录包）—— 原版直接覆盖 $APP，出问题无从退回；
#     ② `.env` 必须在切换前 `cp` 到 app-new —— 打包刻意排除它，漏了就是**全站 AI 静默不可用**；
#     ③ 预演 —— 新代码先跑库副本，出问题不碰生产库。
#
# ★★ 2026-09-21 补闸（工作树体检）
#   tar 按**目录**打包 ⇒ 打的是「工作树」，不是「HEAD」。本仓常有**并行会话**同时在写，
#   于是进行中的改动会被**一起推上生产**，且 `npm run check` 还会连带跑他们的半成品测试。
#   ⇒ 步骤 ⓪ 拦下「packages/** 有未提交改动」；确需强发用 ALLOW_DIRTY=1。
#
# ★★ 2026-09-24 补闸（根级公开文件核对）
#   站点根是 Caddy 的 `root` = `packages/web/dist`，而步骤 ⑦ 是**整目录轮换**（$APP → app-old-$TS）
#   ⇒ 手工 scp 进 dist 的根级文件**下一次发版就没了**（当天就发生过一次：搜索引擎验证文件
#   BingSiteAuth.xml 被直接塞上线）。⇒ 步骤 ①b 断言 `packages/web/public/**` 全数落在 `dist/**`，
#   要长期待在站点根的东西只能走 public/，不能走线上手工塞。
#
# ★★ 2026-09-25 补闸（对外更新表同步核对）
#   线上那页公开更新记录（含 Atom 订阅）的内容是一份**手写的对外清洗表**（`PUBLIC_RELEASES`），
#   每次发版要人工补一行，而这件事从来没有机器拦着——既有的锁只防「把还没上线的版本写进去」，
#   不防「上线了却忘了写」，而后者正是这一页存在的意义被悄悄掏空的那一侧。
#   ⇒ 步骤 ①c 拿「已合并进当前历史的最高 tag」与表头逐字对账（tag ＝这一版真的上线过的唯一机械证据），
#   不一致就停；确知要带着不一致上线才许 SKIP_PUBLIC_CHANGELOG_CHECK=1。判断标准细节见 tools/check-public-changelog.mjs。
#
# ★★ 2026-10-07 补闸（磁盘核算 ＋ 回滚点保留）
#   本脚本原来**只造回滚点、从不删**，且造之前不看盘上还有多少地方。2026-10-07 实测：
#   `app-old-*` 攒 8 份＝2.2GB、`backup/app-predeploy-*.tar.gz` 攒 37 份＝2.7GB、根分区 **87% 满、剩 2.5GB**，
#   而 2026-09-29 已经手工清过一次（DEPLOY.md §11 记着「攒到 20 份 ≈ 4.3GB」）⇒ 清而不改码，八天就长回来。
#   ★ 更要命的是**回滚点写进了 `$BASE/backup`，而那是一个 git 仓**：`/usr/local/bin/sb-backup` 每日
#   `git add -A` 会把 100MB+ 的代码包吞进历史，而 GitHub 拒收 >100MB 的单文件 ⇒ 实测异地备份
#   **从 2026-10-02 起连续 6 天推送失败**（本地 master 领先 origin/master 6 个提交），而脚本把失败原因
#   `2>/dev/null` 吞掉了，日志里只剩一句误导性的 `src refspec main does not match any`。
#   ⇒ 两条改动：① 代码包改落 `$ROLLBACK`（git 仓之外）＋给 backup/ 补 `*.tar.gz` 的 .gitignore；
#      ② ②b 在动手前算一次空间（**半头发版比不发更糟**：⑦ 已 `mv` 走旧 app、新 app 却没空间解包＝线上没代码），
#      ⑨ 在 ⑧ 验证通过之后按保留数清理（放在最后是因为：没验过的发版**一个回滚点都不许删**）。
#
# 用法：
#   bash tools/deploy.sh                  # 正常发布（含预演）
#   DRY_RUN=1 bash tools/deploy.sh        # 只做 体检+校验+构建+打包，不上传不切换（验闸用）
#   SKIP_PRETEST=1 bash tools/deploy.sh   # 跳过预演（仅当你已单独验过）
#   ALLOW_DIRTY=1 bash tools/deploy.sh    # 明知工作树有 packages/** 改动仍发（危险）
#   SKIP_PUBLIC_CHANGELOG_CHECK=1 bash tools/deploy.sh  # 明知对外更新表落后仍发（要写明为什么）
#   SERVER=root@1.2.3.4 KEY=~/.ssh/k bash tools/deploy.sh
#   KEEP_APP_OLD=2 KEEP_APP_TAR=2 KEEP_DB=7 bash tools/deploy.sh   # 保留数量（默认 2/2/7）
#   MIN_FREE_KB=2097152 bash tools/deploy.sh                      # ②b 的空间下限（默认 2GB）
set -euo pipefail

cd "$(dirname "$0")/.."          # 一律在仓库根跑，路径都相对它

SERVER=${SERVER:?必须提供，如 root@203.0.113.10（真实地址不入仓，见私有运维清单）}
KEY=${KEY:-$HOME/.ssh/id_ed25519}
BASE=${BASE:-/opt/studentbuddy}
APP=$BASE/app
# ★ 代码整目录包的家。**刻意不是 $BASE/backup** —— backup/ 是 sb-backup 每日 push 的 git 仓，
#   100MB+ 的包进去就会让整条异地备份链被 GitHub 拒收（缘由见文件头 2026-10-07 那段）。
ROLLBACK=${ROLLBACK:-$BASE/rollback}
KEEP_APP_OLD=${KEEP_APP_OLD:-2}      # 留最近几份 app-old-*（⑦ 整目录轮换的产物）
KEEP_APP_TAR=${KEEP_APP_TAR:-2}      # 留最近几份 rollback/app-predeploy-*.tar.gz
KEEP_DB=${KEEP_DB:-7}                # 留最近几份 backup/db-predeploy-*.db（与 sb-backup 的 7 天窗口对齐）
MIN_FREE_KB=${MIN_FREE_KB:-2097152}  # ②b 空间下限兜底（默认 2GB），实际要求取「算出来的峰值」与它的较大者
SVC=${SVC:-studentbuddy}
PORT=${PORT:-18791}
PRETEST_PORT=${PRETEST_PORT:-18799}
TS=$(date +%Y%m%d-%H%M)
TAR=/tmp/sb-app-$TS.tar.gz

ssh_() { ssh -i "$KEY" -o ConnectTimeout=15 "$SERVER" "$@"; }

echo "=== ⓪ 工作树体检（打包的是工作树，不是 HEAD）==="
DIRTY=$(git status --porcelain | cut -c4- || true)
if [ -z "$DIRTY" ]; then
  echo "✓ 工作树干净 ⇒ 打包内容 = HEAD"
else
  echo "工作树有 $(echo "$DIRTY" | wc -l) 项改动："
  echo "$DIRTY" | sed 's/^/    · /'
  RISKY=$(echo "$DIRTY" | grep -E '^packages/' || true)
  if [ -z "$RISKY" ]; then
    echo "⚠️  都不在 packages/**（非运行时代码）⇒ 继续"
  elif [ "${ALLOW_DIRTY:-0}" = "1" ]; then
    echo "⚠️  ALLOW_DIRTY=1 ⇒ 忽略下列**运行时代码**改动，继续（它们会被一起推上生产）："
    echo "$RISKY" | sed 's/^/    ⚠️  /'
  else
    echo
    echo "✗ 工作树里有**运行时代码**未提交改动 —— tar 按目录打包，它们会被一起推上生产："
    echo "$RISKY" | sed 's/^/    ✗ /'
    echo
    echo "  两条出路："
    echo "    ① 先提交/收尾这些改动（推荐）—— 尤其当它们**不是你改的**（本仓常有并行会话）"
    echo "    ② 确认无碍再发：ALLOW_DIRTY=1 bash tools/deploy.sh"
    exit 2
  fi
fi

echo "=== ① 本地校验 + 构建 ==="
npm run check
npm run build

echo "=== ①b 根级公开文件核对（public/ → dist/）==="
# 站点根 = Caddy 的 root = packages/web/dist，而 ⑦ 是**整目录轮换** ⇒ 没落进 public/ 的
# 根级文件（搜索引擎验证文件是典型）会在发版后静默 404。闸门细节见 tools/check-root-files.sh。
bash tools/check-root-files.sh

echo "=== ①c 对外更新表同步核对（那页不许落后于线上）==="
# 判断标准钉在 tag 上而不是内部拟号上：tag 才是「这一版真的上线过」的机械证据。
node tools/check-public-changelog.mjs

echo "=== ①d 版本号一致性（package.json×4 ＝ CHANGELOG ＝ tag；/api/status 报的就是它）==="
# 2026-09-30 起全仓只有一个版本号；改号用 npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version
node tools/check-version.mjs

echo "=== ② 打包（排除运行时不需要、或绝不能覆盖线上那份的）==="
tar czf "$TAR" \
  --exclude='./node_modules' --exclude='*/node_modules' \
  --exclude='./.git' --exclude='./.env' \
  --exclude='./coverage' --exclude='./test-results' \
  --exclude='./_probe' --exclude='./.workbuddy-ai' \
  --exclude='./docs/images' .
echo "包：$TAR（$(du -h "$TAR" | cut -f1)，$(tar tzf "$TAR" | wc -l) 条目）"
[ "$(tar tzf "$TAR" | grep -c node_modules || true)" = "0" ] || { echo "✗ 包里混进 node_modules"; exit 1; }

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo
  echo "✓ DRY_RUN=1 ⇒ 到此为止：已体检 + 已校验 + 已构建 + 已打包，**未上传、未切换、未碰服务器**"
  echo "  包留档供检查：$TAR"
  exit 0
fi

echo "=== ②b 磁盘核算（为什么要有这步：半头发版比不发更糟）==="
# ⑦ 会把旧 app `mv` 走、⑤ 要把新 app 解包出来 —— 若中途 ENOSPC，线上就同时没有新旧代码，
# 而唯一能退回的那份也在同一块满盘上。所以**动手前先算**，算不过就一行字节都不上传。
TAR_KB=$(du -sk "$TAR" | cut -f1)
AVAIL_KB=$(ssh_ "df --output=avail -k '$BASE' | tail -1 | tr -dc '0-9'")
APP_KB=$(ssh_ "du -sk '$APP' 2>/dev/null | cut -f1 | head -1 || true"); APP_KB=${APP_KB:-0}
if [ -z "$AVAIL_KB" ]; then
  echo "✗ 取不到 $BASE 所在分区的可用空间 ⇒ 无法核算，拒绝发版（宁可停下来问，不要拿半截状态上线）"
  exit 1
fi
# 峰值新增 ＝ ④ 上传的包 ＋ ⑤ 解出的 app-new ＋ ③ 那份整目录包（≈ 当前 app 体积）＋ 库快照/预演余量
NEED_KB=$(( APP_KB * 2 + TAR_KB + 204800 ))
if [ "$NEED_KB" -lt "$MIN_FREE_KB" ]; then NEED_KB=$MIN_FREE_KB; fi
echo "  可用 ${AVAIL_KB} KB ｜ 峰值需要 ${NEED_KB} KB（app=${APP_KB}×2 ＋ 包=${TAR_KB} ＋ 余量 204800）"
if [ "$AVAIL_KB" -lt "$NEED_KB" ]; then
  echo
  echo "✗ 空间不够 —— 这次**没碰服务器**（只跑了两次只读的 df/du）"
  echo "  先手工清掉旧回滚点（与 ⑨ 同口径，只留最近 $KEEP_APP_OLD 份），再重跑本脚本："
  echo "    ssh -i $KEY $SERVER 'cd $BASE && ls -1d app-old-* | sort -r | tail -n +$((KEEP_APP_OLD+1)) | xargs -r rm -rf && ls -1 $ROLLBACK/app-predeploy-*.tar.gz 2>/dev/null | sort -r | tail -n +$((KEEP_APP_TAR+1)) | xargs -r rm -f'"
  exit 1
fi
echo "✓ 够发（富余 $(( AVAIL_KB - NEED_KB )) KB）"

echo "=== ③ 建回滚点（库快照 + 旧代码整目录包）==="
ssh_ "set -e
  mkdir -p $BASE/backup $ROLLBACK
  # ★ 给备份仓钉一条 .gitignore：sb-backup 是 \`git add -A\`，代码包一旦落进这个目录就会被
  #   吞进历史并把 GitHub 的 100MB 单文件上限撞穿（⇒ 异地备份静默断供）。只管**新增**的包；
  #   仓里已有的历史大文件要另做一次性收口（见 DEPLOY.md §11）。
  touch $BASE/backup/.gitignore
  grep -qxF '*.tar.gz' $BASE/backup/.gitignore || echo '*.tar.gz' >> $BASE/backup/.gitignore
  sqlite3 $BASE/data/studentbuddy.db \".backup $BASE/backup/db-predeploy-$TS.db\"
  echo \"库 integrity_check: \$(sqlite3 $BASE/backup/db-predeploy-$TS.db 'PRAGMA integrity_check;')\"
  echo \"库 schema_version:  \$(sqlite3 $BASE/backup/db-predeploy-$TS.db 'select max(version) from schema_version;')\"
  tar czf $ROLLBACK/app-predeploy-$TS.tar.gz -C $BASE app
  ls -la $BASE/backup/db-predeploy-$TS.db $ROLLBACK/app-predeploy-$TS.tar.gz"

echo "=== ④ 上传 + 传输校验 ==="
scp -q -i "$KEY" "$TAR" "$SERVER:/tmp/"
LOCAL_SHA=$(sha256sum "$TAR" | cut -d' ' -f1)
REMOTE_SHA=$(ssh_ "sha256sum /tmp/sb-app-$TS.tar.gz | cut -d' ' -f1")
[ "$LOCAL_SHA" = "$REMOTE_SHA" ] || { echo "✗ 传输校验失败：$LOCAL_SHA != $REMOTE_SHA"; exit 1; }
echo "✓ 两端 sha256 一致：$LOCAL_SHA"

echo "=== ⑤ 解包 app-new + 复用 node_modules + 带 .env ==="
ssh_ "set -e
  rm -rf $BASE/app-new && mkdir -p $BASE/app-new
  tar xzf /tmp/sb-app-$TS.tar.gz -C $BASE/app-new
  cp -a $APP/node_modules $BASE/app-new/node_modules
  cp -a $APP/packages/server/node_modules $BASE/app-new/packages/server/node_modules
  cp -a $APP/.env $BASE/app-new/.env
  diff -q $APP/.env $BASE/app-new/.env && echo '✓ .env 已带过去且与线上一致'"

if [ "${SKIP_PRETEST:-0}" != "1" ]; then
  echo "=== ⑥ 预演（库副本 + $PRETEST_PORT，全程不碰生产库）==="
  ssh_ "set -e
    rm -rf /tmp/pretest && mkdir -p /tmp/pretest
    sqlite3 $BASE/data/studentbuddy.db '.backup /tmp/pretest/studentbuddy.db'
    cd $BASE/app-new/packages/server
    SB_DATA_DIR=/tmp/pretest SB_PORT=$PRETEST_PORT SB_HOST=127.0.0.1 nohup npx tsx src/index.ts > /tmp/pretest.log 2>&1 &
    sleep 18
    echo \"预演 health: \$(curl -sf http://127.0.0.1:$PRETEST_PORT/api/health || echo '(失败)')\"
    echo \"预演库迁移水位: \$(sqlite3 /tmp/pretest/studentbuddy.db 'select max(version) from schema_version;')\"
    P=\$(ss -lntp 2>/dev/null | grep $PRETEST_PORT | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    if [ -n \"\$P\" ]; then kill \$P; echo '预演实例已停'; else echo '预演实例未监听（可能已自行退出）'; fi
    rm -rf /tmp/pretest /tmp/pretest.log"
fi

echo "=== ⑦ 切换 + 重启 ==="
ssh_ "set -e
  mv $APP $BASE/app-old-$TS
  mv $BASE/app-new $APP
  systemctl restart $SVC
  sleep 8
  echo \"服务状态: \$(systemctl is-active $SVC)\"
  echo \"health:    \$(curl -sf http://127.0.0.1:$PORT/api/health)\"
  MP=\$(systemctl show -p MainPID --value $SVC)
  echo \"SB_PLATFORM_* 命中: \$(tr '\\0' '\\n' < /proc/\$MP/environ | grep -c '^SB_PLATFORM_' || true)\""

echo "=== ⑧ 验证（本地 vs 线上 sha256）==="
# ★ 2026-09-29 加 packages/server/dist/index.js：线上 ExecStart 改为跑这份产物（此前是 npx tsx 跑源码），
#   它是「真正被执行的字节」，必须进取证清单；其余三项维持不变。
FILES="packages/web/dist/index.html packages/server/dist/index.js packages/web/src/features/settings/PlatformChannelCard.tsx packages/shared/src/platform-channel.ts"
L=$(sha256sum $FILES | awk '{print $1}' | sort)
R=$(ssh_ "cd $APP && sha256sum $FILES | awk '{print \$1}' | sort")
if [ "$L" = "$R" ]; then
  echo "✓ 线上 = 本地（4 个文件 sha256 全等）"
else
  echo "✗ sha256 不一致 —— 线上不是本地这份代码"; echo "本地:"; echo "$L"; echo "线上:"; echo "$R"; exit 1
fi

echo "=== ⑨ 保留清理（刻意排在 ⑧ 之后：这一版没被验证通过之前，一个回滚点都不许删）==="
# 目录/文件名里的时间戳是 YYYYmmdd-HHMM 零填充 ⇒ `sort -r` 就是「新 → 旧」，`tail -n +N+1` 即「第 N 份之后」。
# 只认本脚本自己造的三种名字（app-old-* / app-predeploy-* / db-predeploy-*）；手工留的 app-broken-* 一律不碰。
ssh_ "set -e
  cd $BASE
  echo \"清理前: \$(ls -1d app-old-* 2>/dev/null | wc -l) 份整目录 ｜ \$(ls -1 $ROLLBACK/app-predeploy-*.tar.gz 2>/dev/null | wc -l) 份代码包 ｜ \$(ls -1 $BASE/backup/db-predeploy-*.db 2>/dev/null | wc -l) 份库快照\"
  OLD=\$(ls -1d app-old-* 2>/dev/null | sort -r | tail -n +$((KEEP_APP_OLD+1)) || true)
  if [ -n \"\$OLD\" ]; then echo '删掉的旧整目录:'; echo \"\$OLD\" | sed 's/^/    · /'; echo \"\$OLD\" | xargs -r rm -rf; fi
  ls -1 $ROLLBACK/app-predeploy-*.tar.gz 2>/dev/null | sort -r | tail -n +$((KEEP_APP_TAR+1)) | xargs -r rm -f
  # ★ 顺手清掉**历史上落在备份仓里**的那些包（③ 改落点之前造的 37 份 ≈2.7GB 就躺在这儿）。
  #   它们是被 sb-backup 那句 git add -A 吞进 git 工作树的同一类产物 ⇒ 只删工作树文件，
  #   git 历史里的 blob 还在（那要另做一次性收口，见 DEPLOY.md §11），但**盘上的地方立刻回来**。
  OLD_TAR=\$(ls -1 $BASE/backup/app-predeploy-*.tar.gz 2>/dev/null | sort -r | tail -n +$((KEEP_APP_TAR+1)) || true)
  if [ -n \"\$OLD_TAR\" ]; then echo '从备份仓里摘掉的旧代码包:'; echo \"\$OLD_TAR\" | sed 's/^/    · /'; echo \"\$OLD_TAR\" | xargs -r rm -f; fi
  ls -1 $BASE/backup/db-predeploy-*.db 2>/dev/null | sort -r | tail -n +$((KEEP_DB+1)) | xargs -r rm -f
  # ④ 传上来的包用完就该删。此前只删本机那份，远端 /tmp 的一直留着（2026-10-07 实测攒了 6 份 ≈ 380MB）。
  rm -f /tmp/sb-app-*.tar.gz
  echo \"清理后 df -h /: \$(df -h / | tail -1)\""

rm -f "$TAR"
echo
echo "✓ deployed to $SERVER"
echo "  回滚：ssh -i $KEY $SERVER 'mv $BASE/app $BASE/app-broken-$TS && mv $BASE/app-old-$TS $BASE/app && systemctl restart $SVC'"
echo "  回滚点：$BASE/app-old-$TS ｜ backup/db-predeploy-$TS.db ｜ rollback/app-predeploy-$TS.tar.gz"
