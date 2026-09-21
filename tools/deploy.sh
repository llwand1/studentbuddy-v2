#!/usr/bin/env bash
# deploy.sh — 一键发布（本机 Git Bash 执行）。
#
# 流程：check → build → 建回滚点 → 打包上传 → 解包 app-new → 带 .env → 复用 node_modules
#       → 预演（库副本，不碰生产库）→ mv 切换 → 重启 → 健康检查 → sha256 取证。
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
#   于是在途改动会被**一起推上生产**，且 `npm run check` 还会连带跑他们的半成品测试。
#   ⇒ 步骤 ⓪ 拦下「packages/** 有未提交改动」；确需强发用 ALLOW_DIRTY=1。
#
# 用法：
#   bash tools/deploy.sh                  # 正常发布（含预演）
#   DRY_RUN=1 bash tools/deploy.sh        # 只做 体检+校验+构建+打包，不上传不切换（验闸用）
#   SKIP_PRETEST=1 bash tools/deploy.sh   # 跳过预演（仅当你已单独验过）
#   ALLOW_DIRTY=1 bash tools/deploy.sh    # 明知工作树有 packages/** 改动仍发（危险）
#   SERVER=root@1.2.3.4 KEY=~/.ssh/k bash tools/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."          # 一律在仓库根跑，路径都相对它

SERVER=${SERVER:-root@107.172.96.209}
KEY=${KEY:-$HOME/.ssh/id_ed25519}
BASE=${BASE:-/opt/studentbuddy}
APP=$BASE/app
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

echo "=== ③ 建回滚点（库快照 + 旧代码整目录包）==="
ssh_ "set -e
  mkdir -p $BASE/backup
  sqlite3 $BASE/data/studentbuddy.db \".backup $BASE/backup/db-predeploy-$TS.db\"
  echo \"库 integrity_check: \$(sqlite3 $BASE/backup/db-predeploy-$TS.db 'PRAGMA integrity_check;')\"
  echo \"库 schema_version:  \$(sqlite3 $BASE/backup/db-predeploy-$TS.db 'select max(version) from schema_version;')\"
  tar czf $BASE/backup/app-predeploy-$TS.tar.gz -C $BASE app
  ls -la $BASE/backup/db-predeploy-$TS.db $BASE/backup/app-predeploy-$TS.tar.gz"

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

echo "=== ⑧ 取证（本地 vs 线上 sha256）==="
FILES="packages/web/dist/index.html packages/web/src/features/settings/PlatformChannelCard.tsx packages/shared/src/platform-channel.ts"
L=$(sha256sum $FILES | awk '{print $1}' | sort)
R=$(ssh_ "cd $APP && sha256sum $FILES | awk '{print \$1}' | sort")
if [ "$L" = "$R" ]; then
  echo "✓ 线上 = 本地（3 个文件 sha256 全等）"
else
  echo "✗ sha256 不一致 —— 线上不是本地这份代码"; echo "本地:"; echo "$L"; echo "线上:"; echo "$R"; exit 1
fi

rm -f "$TAR"
echo
echo "✓ deployed to $SERVER"
echo "  回滚：ssh -i $KEY $SERVER 'mv $BASE/app $BASE/app-broken-$TS && mv $BASE/app-old-$TS $BASE/app && systemctl restart $SVC'"
echo "  回滚点：$BASE/app-old-$TS ｜ backup/db-predeploy-$TS.db ｜ backup/app-predeploy-$TS.tar.gz"
