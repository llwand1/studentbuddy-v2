#!/usr/bin/env bash
# selftest-deploy-retention.sh — 证明 deploy.sh 第 ⑨ 步的保留清理**真的会按保留数删东西**。
#
# ── 为什么需要它 ────────────────────────────────────────────────────────────
# `DEPLOY.md §11` 原话把「回滚目录只增不减」记成了一条**要靠人回头看**的运维边界，2026-09-29
# 也照那条手工清过一次（20 份 ≈ 4.3GB ⇒ 保留最近 2 份）。结果 **2026-10-07 实测又回到 87% 满**
# （8 份整目录 ＋ 37 份代码包 ＋ 远端 /tmp 6 份包）⇒ 登记不等于修好，手工清不等于不会复发。
# 而清理逻辑里含 `sort -r`／`tail -n +N`／`xargs -r rm -rf` 这类**写反了不会报错、只会删错东西**
# 的管道：既可能一个都不删（闸门形同虚设），也可能把**本次发版刚造的那份回滚点**删掉（真出事时无从退回）。
# ⇒ 按本仓对 `tools/` 的既有口径（`check-version.mjs --selftest` 一族：判断标准自带复验，不进 vitest），
#   在这里用假目录把它跑一遍，两侧都断言：该删的删了、不该动的一个没动。
#
# ── 手法（「不重写命令」是关键）───────────────────────────────────────────────
# 不复制一份"看起来一样"的清理代码来测（那样改了 deploy.sh 也照样绿）。而是：
#   1) 从 `tools/deploy.sh` 里**原样抽出**那句 `ssh_ "…"`；
#   2) 把 `ssh_` 换成「把收到的字符串写进文件」，再 source 那句 ⇒ 复现本机对 `$BASE`/`$ROLLBACK`/`$KEEP_*` 的展开；
#   3) 用 bash 跑展开后的那份文本 ⇒ 复现服务器侧真正会执行的字节；
#   4) 断言存活集（含"该留的一个没少"与"别人的东西一个没动"两侧）。
#
# ── 用法 ────────────────────────────────────────────────────────────────────
#   bash tools/selftest-deploy-retention.sh    # CI 与本地（Git Bash）都跑得通；零网络、零生产接触
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${SRC:-$HERE/deploy.sh}
[ -f "$SRC" ] || { echo "✗ 找不到被测脚本：$SRC"; exit 1; }

SIM=$(mktemp -d)
trap 'rm -rf "$SIM"' EXIT
BASE=$SIM/base
mkdir -p "$BASE/backup" "$BASE/rollback" "$BASE/app"

# 5 份整目录 / 5 份代码包 / 8 份库快照（时间戳口径与 deploy.sh 的 TS 一致：YYYYmmdd-HHMM）
STAMPS="20261001-0800 20261002-0900 20261003-1000 20261004-1100 20261007-1200"
for t in $STAMPS; do
  mkdir -p "$BASE/app-old-$t"; echo x > "$BASE/app-old-$t/f"
  : > "$BASE/rollback/app-predeploy-$t.tar.gz"
  : > "$BASE/backup/app-predeploy-$t.tar.gz"   # 历史落点（③ 改之前）：也要被清
done
for t in $STAMPS 20261005-1300 20261006-1400 20260929-0100; do
  : > "$BASE/backup/db-predeploy-$t.db"
done
: > "$BASE/backup/sb-2026-09-24.db"            # 每日库备份（sb-backup 的地盘）：本步骤绝不该碰
mkdir -p "$BASE/app-broken-20261001-0800"      # 手工回滚留下的痕迹：任何自动清理都不许碰

# 抽出第 ⑨ 步那句 ssh_ 调用
awk '/=== ⑨/{f=1;next} f&&/^ssh_ "/{g=1} g{print} g&&/清理后 df -h/{exit}' "$SRC" > "$SIM/step9.src"
[ -s "$SIM/step9.src" ] || { echo "✗ 没能从 $SRC 抽出第 ⑨ 步 —— 步骤编号或收尾文案变了，这条锁要先跟着改"; exit 1; }

run_step9() {   # $1 = 保留份数
  KEY=k SERVER=s BASE="$BASE" ROLLBACK="$BASE/rollback" SVC=x TS=20261007-1300 \
  KEEP_APP_OLD="$1" KEEP_APP_TAR="$1" KEEP_DB=7 bash -c "
    ssh_() { printf '%s' \"\$1\" > '$SIM/remote.sh'; }
    source '$SIM/step9.src'
  "
  bash "$SIM/remote.sh" > /dev/null
}

fail=0
echo "--- 场景 A：保留 2 份 ---"
run_step9 2
got_old=$(cd "$BASE" && ls -1d app-old-* | tr '\n' ' ')
got_tar=$(cd "$BASE" && ls -1 rollback | tr '\n' ' ')
got_db=$(cd "$BASE/backup" && ls -1 db-predeploy-*.db | wc -l)
got_legacy=$(cd "$BASE/backup" && ls -1 app-predeploy-*.tar.gz 2>/dev/null | tr '\n' ' ')
echo "  存活整目录: $got_old"
echo "  存活代码包: $got_tar"
echo "  存活旧落点代码包（backup/ 里的存量）: $got_legacy"
echo "  存活库快照: $got_db 份"
[ "$got_legacy" = "app-predeploy-20261004-1100.tar.gz app-predeploy-20261007-1200.tar.gz " ] || { echo "✗ 备份仓里的旧代码包应只剩最近 2 份，实为: $got_legacy"; fail=1; }
[ "$got_old" = "app-old-20261004-1100 app-old-20261007-1200 " ] || { echo "✗ 整目录应只剩最近 2 份，实为: $got_old"; fail=1; }
[ "$got_tar" = "app-predeploy-20261004-1100.tar.gz app-predeploy-20261007-1200.tar.gz " ] || { echo "✗ 代码包应只剩最近 2 份，实为: $got_tar"; fail=1; }
[ "$got_db" = "7" ] || { echo "✗ 库快照应留 7 份，实为 $got_db"; fail=1; }
[ -d "$BASE/app-broken-20261001-0800" ] || { echo "✗ 手工留的 app-broken-* 被误删了"; fail=1; }
[ -f "$BASE/backup/sb-2026-09-24.db" ] || { echo "✗ 每日备份 sb-*.db 被删了（那由 sb-backup 的 7 天窗口管，不归本步骤）"; fail=1; }
[ -f "$BASE/backup/db-predeploy-20260929-0100.db" ] && { echo "✗ 最旧的库快照没被删 ⇒ 保留数没生效"; fail=1; }

echo "--- 场景 B：保留数改成 3（证明数来自 KEEP_*，不是把 2 写死在管道里）---"
for t in $STAMPS; do mkdir -p "$BASE/app-old-$t"; done
run_step9 3
got_old3=$(cd "$BASE" && ls -1d app-old-* | wc -l)
echo "  存活整目录份数: $got_old3"
[ "$got_old3" = "3" ] || { echo "✗ 保留 3 时应留 3 份，实留 $got_old3"; fail=1; }

echo "--- 场景 C：只有一份回滚目录（首次发版形态）⇒ 一个都不许删 ---"
rm -rf "$BASE"/app-old-*
mkdir -p "$BASE/app-old-20261007-1200"
run_step9 2
[ -d "$BASE/app-old-20261007-1200" ] || { echo "✗ 唯一一份回滚点被删了（真出事时无从退回）"; fail=1; }

echo "--- 场景 D：ssh_ 载荷里不许有未转义的反引号（双引号串里的反引号会**真的被命令替换执行**）---"
# 动因是本批自己踩的一次：⑨ 的注释里写了未转义的反引号版本 ⇒ 跑自测时本机真的执行了一遍 git add -A。
# 这类破坏不在发版日志里留痕，只在操作者的工作树上动手脚 ⇒ 钉成结构锁。
hits=$(awk '/^  /{ if (gsub(/[^\\]`/, "x") > 0) print NR }' "$SRC" | tr '\n' ' ')
scanned=$(awk '/^  /{c++} END{print c+0}' "$SRC")
echo "  扫描两空格缩进（ssh_ 载荷的续行）共 $scanned 行；命中未转义反引号的行号: ${hits:-无}"
[ -z "$hits" ] || { echo "✗ 第 $hits 行含未转义反引号 ⇒ 会被当命令替换在本机执行"; fail=1; }
[ "$scanned" -ge 50 ] || { echo "✗ 只扫到 $scanned 行 ⇒ 这条判据没在真扫（文件的缩进约定变了？）"; fail=1; }

echo
if [ "$fail" = "0" ]; then
  echo "✓ deploy.sh 第 ⑨ 步：该删的删、该留的留、别人的目录（app-broken-* / sb-*.db）一个没动、保留数确由变量决定"
  exit 0
fi
echo "✗ 有断言未通过"
exit 1
