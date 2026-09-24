#!/usr/bin/env bash
# check-root-files.sh — 断言「站点根级公开文件」都随构建产物一起上线。
#
# ★★ 2026-09-24 落地，起因是一条当天实测出来的缺口：
#   线上站点根 = Caddy `root * /opt/studentbuddy/app/packages/web/dist`，
#   而发版是**整目录轮换**（$APP → app-old-<ts>）⇒ 任何手工 scp 进 dist 的根级文件
#   **下一次发版就静默消失**。当天 BingSiteAuth.xml（搜索引擎验证文件）就是这么塞上去的：
#   它只有待在 packages/web/public/ 里才活得过发版，因为 Vite 会把 public/** 原样拷进 dist/**。
#
#   ⇒ 「public/ 里每个文件都必须出现在 dist/ 里」是一条不依赖运行态的结构不变量。
#   它断了只有两种可能：构建没跑（产物过期）或 publicDir 配置被改坏 —— 两种都不该上线。
#
#   ★ 已知缺口（诚实登记）：本闸门**只读盘上的 public/**，不看 git。所以一个未跟踪的
#   public/ 文件能骗绿 —— 换台机器 `git clone` 就没有它，照样会在某次发版后 404。
#   当前 `BingSiteAuth.xml` 正是这种状态（线上 200，仓库里未跟踪）。
#   收紧成 `git ls-files` 之前先想清楚代价：发版第 ⓪ 步的工作树体检**故意**允许
#   `packages/**` 之外的未提交改动，直接改读 git 会让这个新文件在提交前就拦死发版。
#
# 用法：bash tools/check-root-files.sh   （与其它 tools 脚本一样，一律在仓库根跑）
set -euo pipefail

cd "$(dirname "$0")/.."

PUB=packages/web/public
DIST=packages/web/dist

[ -d "$PUB" ] || { echo "✓ 无 $PUB ⇒ 本仓没有公开静态目录，跳过"; exit 0; }
if [ ! -d "$DIST" ]; then
  echo "✗ 没有 $DIST —— 构建产物不存在，先跑 npm run build"
  exit 1
fi

FILES=$(cd "$PUB" && find . -type f | sed 's|^\./||' | sort)
TOTAL=0
MISSING=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  TOTAL=$((TOTAL + 1))
  [ -f "$DIST/$f" ] || MISSING="$MISSING    ✗ $f
"
done <<< "$FILES"

if [ -n "$MISSING" ]; then
  echo "✗ 以下 $PUB/ 文件没出现在 $DIST/ 里 —— 上线后它们会 404（发版不背锅，是拷贝链断了）："
  printf '%s' "$MISSING"
  echo
  echo "  两种可能，按顺序排：① 构建没跑或产物过期 ⇒ 重跑 npm run build；② Vite publicDir 被改坏。"
  echo "  ★ 若是「手工把文件 scp 进了线上 dist」：把它放进 $PUB/ 再提交，否则下次发版它必丢。"
  exit 1
fi

echo "✓ $PUB/ 的 $TOTAL 个文件全部落在 $DIST/（根级公开文件不会因发版轮换而消失）"
